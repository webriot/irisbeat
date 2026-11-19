// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const origin = 'https://irisbeat.example';
const page = '/api/status/partials/page';
const windowMs = 4_000;
const boundary = (at, width = windowMs) => at - at % width + width;

async function until(at) {
  await delay(Math.max(0, at - Date.now()));
}

async function eventually(assertion, deadline = Date.now() + 3_000) {
  for (;;) {
    try { return await assertion(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

module.exports = async function test({ mf, options, application, request, tick, deliveries }) {
  const update = name => request('/api/operator', 'PUT', { pageName: name });
  const status = async () => (await request('/api/status')).json();
  const browserSnapshot = async () => (await mf.dispatchFetch(origin + '/api/status', {
    headers: { Accept: 'application/vnd.irisbeat.view+json' },
  })).json();
  const readPage = async revision => (await request(page + '?revision=' + revision)).json();
  const boot = vars => mf.setOptions(options(application, 'state', true, undefined, vars));

  // Upgrade from #86 using the same persisted MonitoringContext.
  assert.equal((await update('Before publication')).status, 200);
  const oldMonitor = await request('/api/operator/monitors', 'POST', {
    name: 'Pre-upgrade Monitor', url: 'https://target.example/old', failureThreshold: 1,
  });
  assert.equal(oldMonitor.status, 201);
  const oldId = (await oldMonitor.json()).monitor.id;
  await tick(Date.now());
  await boot({});
  const beforeUpgradeWrite = Date.now();
  assert.equal((await update('First write after upgrade')).status, 200);
  await tick(Date.now() + 60_000);
  assert.equal((await request('/api/operator/monitors/' + oldId, 'DELETE')).status, 200);
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  const baseline = await status();
  assert.equal(baseline.pageName, 'Before publication', 'the first upgraded GET retains the pre-write baseline');
  assert.equal(baseline.monitor.id, oldId, 'the pending deletion is hidden');
  assert.equal(baseline.incidents[0].monitorId, oldId);
  assert.equal(baseline.monitor.history.days.reduce((sum, day) => sum + day.failures, 0), 1, 'the later Check is hidden');
  const snapshot = await browserSnapshot();
  assert.equal(snapshot.pageName, baseline.pageName);
  assert.match(snapshot.html, /Pre-upgrade Monitor/);
  const alarmAt = async () => (await request('/test-status-alarm')).json();
  const response = await mf.dispatchFetch(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } });
  assert.equal(response.status, 101);
  const initialSocket = response.webSocket;
  initialSocket.accept();
  assert.equal((await update('Default window')).status, 200);
  assert.equal(await alarmAt(), boundary(beforeUpgradeWrite, 60_000));
  initialSocket.close();

  await boot({ STATUS_RENDER_INTERVAL_SECONDS: '4' });
  // Publish the prior window or preserve its baseline, depending on the next boundary.
  await until(boundary(Date.now()) + 30);
  assert.equal((await status()).pageName, 'Default window');
  await request('/api/operator/webhook', 'PUT', { url: 'https://hooks.example/upgrade' });
  const { destinations } = await (await request('/api/operator')).json();
  const nextWindow = boundary(Date.now()) + 30;
  await until(nextWindow);
  const firstEnd = boundary(Date.now());
  const created = await request('/api/operator/monitors', 'POST', {
    name: 'Published outage', url: 'https://target.example/health', failureThreshold: 1,
  });
  assert.equal(created.status, 201);
  const { monitor } = await created.json();
  const path = '/api/operator/monitors/' + monitor.id;
  const row = '/api/status/partials/monitor/' + monitor.id;
  assert.equal((await request(path, 'PATCH', { destinationIds: [destinations[0].id] })).status, 200);
  await tick(Date.now() + 60_000);
  await eventually(() => assert.equal(deliveries.length, 1), firstEnd);
  assert.equal((await (await request('/api/operator')).json()).monitor.state, 'down');
  assert.equal((await status()).monitor, null, 'an alert arrives before the public window');
  assert.equal(await alarmAt(), null, 'a context without public subscribers has no publication alarm');
  assert.equal((await request(page + '?revision=999')).status, 409);
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  await mf.purgeCache();
  assert.equal((await status()).pageName, 'Default window', 'a cold read also serves the retained publication');
  await until(firstEnd + 30);
  assert.equal(await alarmAt(), null);
  assert.equal((await status()).monitor.state, 'down', 'the first GET advances a due publication');
  assert.match(await (await request('/')).text(), /Published outage/);
  assert.match((await (await request(row)).json()).html, /Published outage/);

  // An active hibernating subscription receives one hint for the rendered scopes.
  const upgrade = await mf.dispatchFetch(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } });
  assert.equal(upgrade.status, 101);
  const socket = upgrade.webSocket;
  socket.accept();
  const hints = [];
  socket.addEventListener('message', event => hints.push(JSON.parse(event.data)));
  const start = (await readPage(0)).revision;
  await until(boundary(Date.now()) + 30);
  const subscriberEnd = boundary(Date.now());
  await update('First edit');
  await update('Second edit');
  assert.equal((await request(path + '/maintenance', 'PUT', { endsAt: Date.now() + 60_000 })).status, 200);
  assert.equal((await request(path, 'PATCH', { published: false })).status, 200);
  assert.equal(await alarmAt(), subscriberEnd);
  const operator = await request('/api/operator');
  assert.equal(operator.headers.get('Cache-Control'), 'no-store');
  assert.equal((await operator.json()).monitor.published, false);
  assert.equal((await mf.dispatchFetch(origin + '/api/operator')).status, 401);
  assert.equal((await status()).monitor.name, 'Published outage');
  const edge = await mf.getWorker('status-edge');
  const split = (hostname, at) => edge.fetch('https://' + hostname + '/api/status', { headers: { 'x-test-at': String(at) } });
  const fastClock = subscriberEnd + 50;
  await until(subscriberEnd - 600);
  const warm = await split('fast.example', fastClock);
  assert.equal((await warm.json()).monitor.name, 'Published outage', 'the DO still owns the old publication');
  assert.deepEqual(hints, []);
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  const hostedPublication = async () => (await request('/test-status-published')).json();
  await eventually(async () => {
    assert.equal((await hostedPublication())?.hint.revision, start + 4);
  }, subscriberEnd + 2_000);
  await eventually(() => assert.equal(hints.length, 1), subscriberEnd + 3_000);

  const [hint] = hints;
  assert.deepEqual(hint, {
    type: 'changed', revision: start + 4, scopes: ['page', 'banner', 'monitors', 'incidents'],
  });
  const publicPage = await readPage(hint.revision);
  assert.deepEqual(publicPage, { revision: hint.revision, html: '<h1>Second edit</h1>' });
  const committed = await hostedPublication();
  assert.deepEqual(committed.hint, hint);
  assert.deepEqual(committed.partials.map(([scope, partial]) => [scope, partial.revision]), hint.scopes.map(scope => [scope, hint.revision]));
  assert.deepEqual(committed.partials[0], ['page', publicPage]);
  assert.equal((await (await request(row + '?revision=' + hint.revision)).json()).html, '');
  assert.equal((await status()).monitor, null, 'ordinary reads catch up without a hint');
  assert.equal((await (await split('cold.example', fastClock)).json()).monitor, null);
  assert.equal((await (await split('fast.example', fastClock)).json()).monitor, null, 'the warmed edge cannot retain an unpublished Monitor');
  assert.ok(await mf.purgeCache() > 0, 'the Worker populated the regional cache');
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  for (const [scope, partial] of committed.partials) {
    const cold = await mf.dispatchFetch('https://cold.example/api/status/partials/' + scope + '?revision=' + hint.revision);
    assert.deepEqual(await cold.json(), partial);
  }
  assert.deepEqual(await hostedPublication(), committed);
  assert.deepEqual(await readPage(start), publicPage, 'a stale hint cannot move an edge backward');
  assert.equal((await request(page + '?revision=' + (hint.revision + 1))).status, 409);
  socket.send('ack');

  // Closing the last public subscription cancels a queued publication.
  await update('After disconnect');
  const close = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.close(1000);
  await close;
  await eventually(async () => assert.equal(await alarmAt(), null));

  // Resolve two trusted contexts on one host and use the same resource URL at its edge.
  const tenant = (id, path, init = {}) => mf.dispatchFetch('https://tenants.example' + path, {
    ...init, headers: { 'x-test-tenant': id, 'x-context-id': 'wrong-context', ...init.headers },
  });
  assert.equal((await tenant('alpha', '/api/operator', { method: 'PUT', headers: {
    Authorization: 'Bearer fixture', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ pageName: 'Alpha Status' }) })).status, 200);
  assert.doesNotMatch(await (await tenant('alpha', '/')).text(), /Alpha Status/, 'a new tenant starts with the pre-write shell');
  assert.equal((await (await tenant('alpha', '/api/status')).json()).pageName, 'Irisbeat');
  await until(boundary(Date.now()) + 30);
  assert.match(await (await tenant('alpha', '/')).text(), /Alpha Status/);
  assert.doesNotMatch(await (await tenant('beta', '/')).text(), /Alpha Status/);
  assert.equal((await tenant('beta', '/api/operator')).status, 401);
  await mf.purgeCache();
  const administrator = await request('/api/operator/partials/destinations');
  assert.equal(administrator.headers.get('Cache-Control'), 'no-store');
  assert.match(await administrator.text(), /hooks\.example/);
  assert.equal(await mf.purgeCache(), 0, 'authenticated partials do not populate the edge cache');
  for (const asset of ['/operator', '/app.css', '/theme.js', '/operator.js']) {
    const first = await request(asset);
    const repeat = await request(asset + '?version=ignored');
    assert.equal(first.headers.get('Cache-Control'), 'no-store');
    assert.equal(await repeat.text(), await first.text());
  }
  assert.equal(await mf.purgeCache(), 4, 'each static resource has one cache entry');

  await boot({ STATUS_RENDER_INTERVAL_SECONDS: '86400' });
  const delayedName = (await status()).pageName;
  await update('Obsolete delayed edit');
  assert.equal((await status()).pageName, delayedName);
  await boot({ STATUS_RENDER_INTERVAL_SECONDS: '0' });
  await update('Immediate edit');
  assert.equal((await status()).pageName, 'Immediate edit');
  await boot({ STATUS_RENDER_INTERVAL_SECONDS: '86400' });
  await update('New delayed edit');
  assert.equal((await status()).pageName, 'Immediate edit', 'returning to delayed mode retains the immediate revision');
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  assert.equal((await status()).pageName, 'Immediate edit');

  await boot({ STATUS_RENDER_INTERVAL_SECONDS: 'broken' });
  assert.equal((await request('/app.css')).status, 200);
  assert.equal((await request('/api/status')).status, 200);
  assert.equal((await update('Malformed binding fallback')).status, 200);
  assert.equal((await mf.dispatchFetch(origin + '/api/operator')).status, 401);
  const failedCheck = await request('/api/operator/monitors', 'POST', {
    name: 'Private check with invalid publication setting', url: 'https://target.example/health',
    failureThreshold: 1, published: false,
  });
  assert.equal(failedCheck.status, 201);
  const failedId = (await failedCheck.json()).monitors.at(-1).id;
  await request('/api/operator/monitors/' + failedId, 'PATCH', { destinationIds: [destinations[0].id] });
  assert.equal((await tick(Date.now() + 60_000)).status, 200);
  await eventually(() => assert.equal(deliveries.length, 2));
  assert.equal((await (await request('/api/operator')).json()).monitors.at(-1).state, 'down');
  console.log('PASS: Worker upgrade, configurable publication, regional misses, hibernation, unsubscribe, alerts, and tenant isolation');
};
