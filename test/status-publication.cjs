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

module.exports = async function test({ mf, options, application, cachedSQLite, request, tick, deliveries, fresh }) {
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
  assert.ok(baseline.monitor.history.days.every(day => day.state === 'empty'), 'SQLite history is retired and the later Check is hidden');
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

  // Let one window elapse without a request or a subscriber to publish it.
  await until(boundary(Date.now()) + 30);
  const idleRevision = (await readPage(0)).revision;
  const idleEnd = boundary(Date.now());
  await update('Last edit in the elapsed window');
  await until(idleEnd + 30);
  await update('First edit in the open window');
  assert.equal(await alarmAt(), null);
  assert.deepEqual(await readPage(idleRevision + 1), {
    revision: idleRevision + 1, html: '<h1>Last edit in the elapsed window</h1>',
  });
  assert.equal((await request(page + '?revision=' + (idleRevision + 2))).status, 409);
  assert.equal((await status()).pageName, 'Last edit in the elapsed window');
  await mf.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
  assert.equal((await status()).pageName, 'Last edit in the elapsed window', 'warm edge');
  await mf.purgeCache();
  assert.equal((await browserSnapshot()).pageName, 'Last edit in the elapsed window', 'cold negotiated snapshot');
  await until(boundary(idleEnd) + 30);
  assert.equal((await status()).pageName, 'First edit in the open window');

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

  await boot({ STATUS_RENDER_INTERVAL_SECONDS: '60' });
  const midnight = Date.UTC(2030, 0, 2);
  const clock = async at => assert.equal((await request('/test-status-clock' + (at === undefined ? '' : '?at=' + at))).status, 204);
  await clock(midnight - 180_000);
  try {
    const ids = [];
    for (const [name, endsAt] of [
      ['Early expiry', midnight - 110_000], ['Second expiry', midnight - 45_000], ['Late expiry', midnight + 35_000],
    ]) {
      const created = await request('/api/operator/monitors', 'POST', { name, kind: 'heartbeat' });
      assert.equal(created.status, 201);
      const id = (await created.json()).monitors.at(-1).id;
      ids.push(id);
      assert.equal((await request('/api/operator/monitors/' + id + '/maintenance', 'PUT', { endsAt })).status, 200);
    }
    await clock(midnight - 120_000);
    const maintained = await status();
    assert.deepEqual(maintained.monitors.map(monitor => monitor.state), ['maintenance', 'maintenance', 'maintenance']);
    assert.equal(await alarmAt(), null);
    const maintainedRevision = (await readPage(0)).revision;
    await clock(midnight + 40_000);
    const between = await status();
    assert.deepEqual(between.monitors.map(monitor => monitor.state), ['unknown', 'unknown', 'maintenance'],
      'the first late GET publishes elapsed expiries and retains Maintenance from the still-open window');
    assert.equal(between.monitor.history.days.at(-1).date, '2030-01-01');
    const expiryPublication = await hostedPublication();
    assert.deepEqual(expiryPublication.hint, {
      type: 'changed', scopes: ['banner', 'monitor/' + ids[0], 'monitor/' + ids[1]], revision: maintainedRevision + 2,
    });
    await mf.purgeCache();
    assert.match((await browserSnapshot()).html, /2030-01-01 UTC/);
    await clock(midnight + 60_000);
    const rolled = await status();
    assert.deepEqual(rolled.monitors.map(monitor => monitor.state), ['unknown', 'unknown', 'unknown']);
    assert.equal(rolled.monitor.history.days.at(-1).date, '2030-01-02');
    const nextDay = midnight + 86_400_000;
    await clock(nextDay + 116_000);
    assert.equal((await status()).monitor.history.days.at(-1).date, '2030-01-03',
      'the first GET after an elapsed UTC rollover uses the effective midnight');

    const prior = await hostedPublication();
    const lateUpgrade = await mf.dispatchFetch(origin + '/api/status/events/v2', { headers: { Upgrade: 'websocket', Origin: origin } });
    assert.equal(lateUpgrade.status, 101);
    const lateSocket = lateUpgrade.webSocket;
    lateSocket.accept();
    const notices = [];
    lateSocket.addEventListener('message', event => notices.push(JSON.parse(event.data)));
    const runDelayedAlarm = async () => assert.equal((await request('/test-status-delayed-alarm')).status, 204);
    await clock(nextDay + 125_000);
    await update('Elapsed before delayed alarm');
    await clock(nextDay + 181_000);
    assert.equal((await request('/api/operator/monitors/' + ids[0], 'PATCH', { intervalSeconds: 120 })).status, 200);
    assert.equal((await request('/api/operator/monitors', 'POST', { name: 'Private after boundary', kind: 'heartbeat', published: false })).status, 201);
    assert.equal((await request('/heartbeat/' + ids[0], 'POST')).status, 204);
    assert.equal((await request('/api/operator/monitors/' + ids[1], 'PATCH', { published: false })).status, 200);
    assert.deepEqual(await hostedPublication(), prior, 'writes and observations do not render');
    assert.equal(await alarmAt(), nextDay + 180_000, 'later writes retain the alarm deadline');
    const [, eligible] = await Promise.all([runDelayedAlarm(), status()]);
    assert.equal(eligible.pageName, 'Elapsed before delayed alarm');
    assert.deepEqual(eligible.monitors.map(monitor => monitor.id), ids);
    assert.equal(eligible.monitor.lastSeen, null);
    assert.equal(eligible.monitor.history.days.at(-1).successes, 0, 'the next window cannot leak history into the sealed publication');
    assert.deepEqual(await readPage(prior.hint.revision + 1), {
      revision: prior.hint.revision + 1, html: '<h1>Elapsed before delayed alarm</h1>',
    });
    await eventually(() => assert.deepEqual(notices, [
      { type: 'changed', revision: prior.hint.revision + 1, scopes: ['page'] },
    ]));
    lateSocket.send('ack');
    await clock(nextDay + 240_000);
    await mf.purgeCache();
    await Promise.all([runDelayedAlarm(), runDelayedAlarm(), browserSnapshot()]);
    await eventually(() => assert.deepEqual(notices, [
      { type: 'changed', revision: prior.hint.revision + 1, scopes: ['page'] },
      { type: 'changed', revision: prior.hint.revision + 3, scopes: ['banner', 'monitors', 'incidents'] },
    ]));
    const latest = await status();
    assert.deepEqual(latest.monitors.map(monitor => monitor.id), [ids[0], ids[2]]);
    assert.equal(latest.monitor.lastSeen, nextDay + 181_000);
    assert.equal(latest.monitor.history.days.at(-1).successes, 1, 'the eligible publication includes the received Heartbeat');
    const lateClose = new Promise(resolve => lateSocket.addEventListener('close', resolve, { once: true }));
    lateSocket.close(1000);
    await lateClose;
    const laterDay = nextDay + 3 * 86_400_000;
    await clock(laterDay + 10_000);
    assert.equal((await status()).monitor.history.days.at(-1).date, '2030-01-05');
    await clock(laterDay + 60_000);
    assert.equal((await status()).monitor.history.days.at(-1).date, '2030-01-06');
  } finally {
    await clock();
  }

  // A predecessor can have SQLite history in an already-published projection.
  const cached = fresh(options(cachedSQLite, 'cached-state', false, undefined, { STATUS_RENDER_INTERVAL_SECONDS: '60' }));
  try {
    const day = Date.now() - Date.now() % 86_400_000;
    const send = (path, time, method = 'GET', body) => cached.dispatchFetch(origin + path, {
      method, headers: { authorization: 'Bearer upgrade-test-secret', 'content-type': 'application/json', 'x-test-at': String(time) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const created = await send('/api/operator/monitors', day + 1000, 'POST', { name: 'SQLite history', kind: 'heartbeat' });
    assert.equal(created.status, 201);
    const { monitor } = await created.json();
    assert.equal((await send('/heartbeat/' + monitor.id, day + 2000, 'POST')).status, 204);
    const publishedAt = day + 61_000;
    const read = () => send('/api/status', publishedAt + 1000).then(response => response.json());
    const before = await read();
    assert.equal(before.monitor.history.days.at(-1).successes, 1);
    await send('/api/operator', publishedAt + 1000, 'PUT', { pageName: 'Pending rename' });
    await cached.setOptions(options(application, 'cached-state', false, undefined, { STATUS_RENDER_INTERVAL_SECONDS: '60' }));
    const after = await read();
    assert.equal(after.pageName, before.pageName);
    assert.equal(after.monitor.id, before.monitor.id);
    assert.deepEqual(after.monitor.lastResult, before.monitor.lastResult);
    assert.ok(after.monitor.history.days.every(day => day.state === 'empty'));
  } finally { await cached.dispose(); }

  // Warm long-window cache entries must recover through a scoped retry and an ordinary GET.
  const history = fresh(options(application, 'history-state', false, undefined, { STATUS_RENDER_INTERVAL_SECONDS: '86400' }));
  try {
    const day = Date.now() - Date.now() % 86_400_000;
    const at = (path, time, method = 'GET', body, accept) => history.dispatchFetch(origin + path, {
      method, headers: { authorization: 'Bearer upgrade-test-secret', 'content-type': 'application/json',
        'x-test-at': String(time), ...(accept ? { Accept: accept } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const readAt = (path, time, accept) => at(path, time, 'GET', undefined, accept).then(response => response.json());
    const heartbeat = async name => {
      const response = await at('/api/operator/monitors', day + 1000, 'POST', { name, kind: 'heartbeat' });
      assert.equal(response.status, 201);
      const monitor = (await response.json()).monitors.at(-1);
      assert.equal((await at('/heartbeat/' + monitor.id, day + 2000, 'POST')).status, 204);
      return monitor;
    };
    const first = await heartbeat('First history');
    const second = await heartbeat('Second history');
    const third = await heartbeat('Third history');
    const mode = value => at('/test-history-mode?mode=' + value, day);
    await mode('failed');
    const publishedAt = day + 86_400_000 + 1000;
    const json = '/api/status';
    const accept = 'application/vnd.irisbeat.view+json';
    const ledger = '/api/status/partials/monitors';
    const row = id => '/api/status/partials/monitor/' + id;
    const old = await readAt(json, publishedAt);
    assert.equal(old.monitors[0].history, null);
    for (const record of [old.monitor, ...old.monitors]) {
      assert.equal(Object.hasOwn(record, 'historyRetryToken'), false);
      assert.equal(Object.hasOwn(record, 'historyRevision'), false);
    }
    assert.match((await readAt(json, publishedAt, accept)).html, /Bars unavailable/);
    assert.match((await readAt(ledger, publishedAt)).html, /Bars unavailable/);
    const pendingRow = await readAt(row(first.id), publishedAt);
    assert.match(pendingRow.html, /Bars unavailable/);
    assert.match(pendingRow.html, /data-history-token="[a-f0-9-]{36}"/);
    assert.equal((await readAt('/test-history-queries', publishedAt)).length, 1, 'warm unresolved reads respect the retry deadline');
    await at('/api/operator/monitors/' + first.id, publishedAt + 1500, 'PATCH', { published: false });
    // This later receipt is deliberately backdated into the old day.
    assert.equal((await at('/test-backdated-heartbeat?id=' + first.id + '&observed-at=' + (day + 3000),
      publishedAt + 2000, 'POST')).status, 204);
    await history.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
    await mode('ingested');
    const retryAt = publishedAt + 30_000;
    assert.match((await readAt(row(first.id), retryAt)).html, /100.00%/);
    assert.deepEqual((await readAt('/test-history-queries', retryAt)).map(query => query.monitorIds), [[first.id]]);
    await mode('failed');
    for (const offset of [30_000, 60_000, 90_000, 120_000]) {
      assert.match((await readAt(row(third.id), publishedAt + offset)).html, /Bars unavailable/);
    }
    await mode('ingested');
    const afterRetries = publishedAt + 150_000;
    const repaired = await readAt(json, afterRetries);
    assert.equal(repaired.monitors[0].id, first.id, 'the unpublished Monitor stays visible until its next publication');
    const publishedDay = new Date(day).toISOString().slice(0, 10);
    assert.equal(repaired.monitors[0].history.days.at(-1).date, publishedDay);
    assert.equal(repaired.monitors[0].history.days.at(-1).successes, 1, 'the published fence excludes the later backdated observation');
    for (const monitor of repaired.monitors.slice(1)) assert.equal(monitor.history.days.at(-1).successes, 1);
    assert.deepEqual((await readAt('/test-history-queries', afterRetries)).map(query => query.monitorIds).at(-1), [second.id, third.id]);
    for (const html of [(await readAt(json, afterRetries, accept)).html, (await readAt(ledger, afterRetries)).html]) {
      assert.match(html, /100.00%/);
      assert.doesNotMatch(html, /Bars unavailable/);
    }
    assert.equal((await at('/heartbeat/' + second.id, afterRetries + 1000, 'POST')).status, 204);
    const queries = () => readAt('/test-history-queries', afterRetries);
    const queryCount = (await queries()).length;
    await mode('held');
    const nextWindow = publishedAt + 86_400_000;
    const inFlight = readAt(json, nextWindow);
    await eventually(async () => assert.equal((await queries()).length, queryCount + 1));
    assert.equal((await at('/api/operator/monitors/' + second.id, nextWindow + 1000, 'PATCH', { published: false })).status, 200);
    await mode('ingested');
    const sealed = await inFlight;
    assert.deepEqual(sealed.monitors.map(monitor => monitor.id), [second.id, third.id],
      'an Operator edit during a query cannot replace its sealed publication');
    assert.equal(sealed.monitor.history.days.at(-1).successes, 1);
    assert.deepEqual((await queries()).at(-1).monitorIds, [second.id, third.id]);
    assert.ok(await history.purgeCache() > 0, 'warm recovery repopulates the public cache under a new generation');
  } finally { await history.dispose(); }

  // Recover an older Calendar outcome at the exact boundary, then ingest it late.
  const deferred = fresh(options(application, 'deferred-history-state', false, undefined, { STATUS_RENDER_INTERVAL_SECONDS: '60' }));
  try {
    const midnight = Date.now() - Date.now() % 86_400_000;
    const cutoff = midnight + 12 * 3_600_000;
    const actual = midnight - 30_000;
    const at = (path, time, method = 'GET', body) => deferred.dispatchFetch(origin + path, {
      method, headers: { authorization: 'Bearer upgrade-test-secret', 'content-type': 'application/json', 'x-test-at': String(time) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (path, time) => at(path, time).then(response => response.json());
    const created = await at('/api/operator/monitors', midnight - 61_000, 'POST', {
      name: 'Deferred Calendar', kind: 'heartbeat', scheduleMode: 'calendar', cron: '59 23 * * *', timezone: 'UTC', graceSeconds: 30,
    });
    assert.equal(created.status, 201);
    const { monitor } = await created.json();
    const row = '/api/status/partials/monitor/' + monitor.id;
    const run = (time, schedule = time) => at('/test-tick?at=' + schedule, time);
    await at('/test-history-mode?mode=write-rejected', cutoff - 30_000);
    assert.equal((await run(cutoff - 30_000)).status, 200);
    const operator = await json('/api/operator', cutoff - 30_000);
    assert.deepEqual(operator.monitor.lastResult, { at: actual, outcome: 'failure' });
    assert.equal(operator.incidents.length, 1);
    await deferred.unsafeEvictDurableObject('irisbeat', 'MonitoringContext', { name: 'personal', webSockets: 'hibernate' });
    await at('/test-history-mode?mode=lagging', cutoff);
    assert.equal((await run(cutoff, cutoff - 30_000)).status, 200);
    const sealed = await json('/api/status', cutoff);
    assert.equal(sealed.monitor.history.days.at(-2).failures, 0);
    const sealedHint = (await json('/test-status-published', cutoff)).hint;

    await at('/test-history-mode?mode=ingested', cutoff + 15_000);
    assert.match((await json(row, cutoff + 15_000)).html, /No observations/);
    assert.equal((await json('/api/status', cutoff + 15_000)).monitor.history.days.at(-2).failures, 0,
      'a point logged exactly at the cutoff is excluded, even after it becomes queryable');

    await at('/test-history-mode?mode=lagging', cutoff + 60_000);
    assert.match((await json(row, cutoff + 60_000)).html, /No observations/);
    const published = await json('/test-status-published', cutoff + 60_000);
    assert.deepEqual(published.hint.scopes, ['monitor/' + monitor.id]);
    assert.ok(published.hint.revision > sealedHint.revision);
    await at('/test-history-mode?mode=ingested', cutoff + 75_000);
    assert.match((await json(row, cutoff + 75_000)).html, /0.00%/);
    const repaired = await json('/api/status', cutoff + 75_000);
    assert.equal(repaired.monitor.history.days.at(-2).failures, 1, 'the Calendar outcome counts on its actual UTC day');
    assert.equal(repaired.monitor.history.days.at(-1).failures, 0);
    assert.deepEqual((await json('/test-history-queries', cutoff + 75_000)).map(query => query.loggedBefore),
      [cutoff / 1000, cutoff / 1000, (cutoff + 60_000) / 1000, (cutoff + 60_000) / 1000]);
  } finally { await deferred.dispose(); }

  console.log('PASS: Worker upgrade, configurable publication, regional misses, hibernation, unsubscribe, alerts, and tenant isolation');
};
