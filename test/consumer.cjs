// SPDX-License-Identifier: AGPL-3.0-only
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const project = process.cwd();
const localRequire = createRequire(join(project, 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');
(async () => {
  execFileSync('npm', ['run', 'pack:engine'], { stdio: 'inherit' });
  const artifact = 'dist/irisbeat-0.1.0.tgz';
  const checksum = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  execFileSync('npm', ['run', 'pack:engine'], { stdio: 'pipe' });
  assert.equal(createHash('sha256').update(readFileSync(artifact)).digest('hex'), checksum, 'packing the same revision is reproducible');
  writeFileSync('dist/SHA256SUMS', checksum + '  irisbeat-0.1.0.tgz\n');
  rmSync('test/consumer/node_modules', { recursive: true, force: true });
  rmSync('test/consumer/package-lock.json', { force: true });
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: join(project, 'test/consumer'), stdio: 'inherit' });
  execFileSync('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: join(project, 'test/consumer'), stdio: 'inherit' });
  execFileSync(join(project, 'node_modules/.bin/tsc'), ['--noEmit', '--project', 'test/consumer/tsconfig.json'], { stdio: 'inherit' });
  const installed = JSON.parse(readFileSync('test/consumer/node_modules/irisbeat/package.json', 'utf8'));
  assert.equal(installed.version, '0.1.0');
  const lock = JSON.parse(readFileSync('test/consumer/package-lock.json', 'utf8'));
  assert.equal(lock.packages['node_modules/irisbeat'].version, '0.1.0');
  assert.equal(lock.packages['node_modules/irisbeat'].integrity, 'sha512-' + createHash('sha512').update(readFileSync(artifact)).digest('base64'));
  const script = (await build({ entryPoints: ['test/consumer/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], plugins: [{
    name: 'substitute-external-tcp-target',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'test-target' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-target' }, () => ({ contents: `export function connect(address) { return {
        opened: fetch('https://tcp-target.example/' + encodeURIComponent(address.hostname) + '/' + address.port).then(response => { if (!response.ok) throw new Error('refused'); }),
        closed: Promise.resolve(), close: async () => {},
      }; }` }));
    },
  }] })).outputFiles[0].text;
  const deliveries = [], webhooks = [];
  let outcome = 503;
  let deliveryFails = false;
  let releaseWebhook, webhookStarted;
  let holdWebhook = false;
  let overlapAction;
  let now = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'consumer', modules: true, script, compatibilityDate: '2026-11-13', durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } }, outboundService: async request => {
    if (request.url.startsWith('https://delivery.example/')) { deliveries.push(await request.json()); return new Response(null, { status: deliveryFails ? 503 : 204 }); }
    if (request.url.startsWith('https://webhook.example/')) { webhooks.push(await request.json());
      if (holdWebhook) { await new Promise(resolve => { releaseWebhook = resolve; webhookStarted(); }); }
      return new Response(null, { status: 204 }); }
    if (overlapAction) await overlapAction();
    return new Response(null, { status: outcome });
  } }));
  const request = (host, path, method = 'GET', body, token = 'editor') => mf.dispatchFetch('https://' + host + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-test-at': String(now) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const tick = at => { now = at; return request('a.example', '/test-tick?at=' + at); };
  try {
    assert.equal((await request('a.example', '/test-unsupported-version')).status, 409);
    new (require('node:vm').Script)(await (await request('a.example', '/operator.js')).text());
    await request('a.example', '/api/operator/monitors', 'POST', { name: 'Private API', url: 'https://target.example/', published: false });
    await request('a.example', '/api/operator/webhook', 'PUT', { url: 'https://webhook.example/private-token' });
    await request('b.example', '/api/operator/monitors', 'POST', { name: 'Other API', url: 'https://other.example/', failureThreshold: 100 });
    await tick(60_000); await tick(120_000); await tick(180_000);
    assert.equal(deliveries.length, 1, 'consumer receives exactly one committed opening');
    assert.equal(deliveries[0].transition, 'opened');
    assert.equal(deliveries[0].incident.monitorName, 'Private API');
    assert.equal(deliveries[0].at, 120_000);
    assert.equal(deliveries[0].incident.closedAt, null);
    outcome = 204; await tick(240_000); await tick(300_000);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].transition, 'recovered');
    assert.equal(deliveries[1].incident.id, deliveries[0].incident.id);
    assert.equal(deliveries[1].incident.closedAt, 300_000);
    assert.deepEqual(webhooks, [{ text: 'Private API: Incident opened' }, { text: 'Private API: Incident recovered' }]);
    const a = await (await request('a.example', '/api/operator')).json();
    const b = await (await request('b.example', '/api/operator')).json();
    assert.equal(a.incidents.length, 1); assert.equal(b.incidents.length, 0);
    assert.equal(JSON.stringify(deliveries).includes('private-token'), false);
    const created = await request('a.example', '/api/operator/monitors', 'POST', { name: 'Producer', kind: 'heartbeat', silenceSeconds: 60, recoveryThreshold: 1 });
    assert.equal(created.status, 201);
    const heartbeat = (await created.json()).monitors.at(-1);
    const rotationPath = '/api/operator/monitors/' + heartbeat.id + '/heartbeat-secret';
    const { secret } = await (await request('a.example', rotationPath, 'POST')).json();
    assert.equal((await request('b.example', '/heartbeat', 'POST', undefined, secret)).status, 401);
    deliveryFails = true;
    await tick(360_000); await tick(370_000);
    assert.equal(deliveries.length, 3, 'failed hook never repeats the opening');
    assert.equal((await (await request('a.example', '/api/operator')).json()).monitors.at(-1).state, 'down');
    now = 375_000;
    assert.equal((await request('a.example', '/heartbeat', 'POST', 'ignored body', secret)).status, 204);
    assert.equal(deliveries.length, 4);
    assert.equal(deliveries[3].transition, 'recovered');
    assert.equal((await (await request('a.example', '/api/operator')).json()).monitors.at(-1).state, 'up');
    const replacement = await (await request('a.example', rotationPath, 'POST')).json();
    assert.equal((await request('a.example', '/heartbeat', 'POST', undefined, secret)).status, 401);
    assert.equal((await request('a.example', '/heartbeat', 'POST', undefined, replacement.secret)).status, 204);
    const reader = await (await request('a.example', '/api/operator', 'GET', undefined, 'reader')).json();
    assert.equal(JSON.stringify(reader).includes('private-token'), false);
    assert.equal((await request('a.example', rotationPath, 'POST', undefined, 'reader')).status, 403);
    assert.deepEqual(webhooks.slice(2), [{ text: 'Producer: Incident opened' }, { text: 'Producer: Incident recovered' }]);
    await request('a.example', '/api/operator/monitors/' + heartbeat.id, 'DELETE');
    deliveryFails = false; outcome = 503;
    const tcpResponse = await request('b.example', '/api/operator/monitors', 'POST', { name: 'Private database', kind: 'tcp', hostname: 'db.example', port: 5432, failureThreshold: 1, recoveryThreshold: 1, published: false });
    assert.equal(tcpResponse.status, 201);
    const tcp = (await tcpResponse.json()).monitors.at(-1);
    assert.equal((await request('b.example', '/api/operator/monitors', 'POST', { name: 'Over allowance', kind: 'heartbeat' })).status, 409);
    await tick(420_000);
    outcome = 204; await tick(480_000);
    const tcpEvents = deliveries.filter(event => event.incident.monitorId === tcp.id);
    assert.deepEqual(tcpEvents.map(event => event.transition), ['opened', 'recovered']);
    assert.notEqual(tcpEvents[0].contextId, deliveries[0].contextId);
    assert.equal((await (await request('b.example', '/api/status')).json()).monitors.some(monitor => monitor.id === tcp.id), false);
    // Verify both delivery paths from the installed engine, with no tenant left checking in parallel.
    for (const host of ['a.example', 'b.example']) {
      const current = await (await request(host, '/api/operator')).json();
      for (const monitor of current.monitors) await request(host, '/api/operator/monitors/' + monitor.id, 'DELETE');
    }
    for (const kind of ['http', 'tcp', 'heartbeat']) {
      const base = now + 60_000;
      now = base; outcome = 204;
      const target = kind === 'http' ? { url: 'https://target.example/' } : kind === 'tcp' ? { hostname: 'db.example', port: 5432 } : { silenceSeconds: 60 };
      const added = await (await request('a.example', '/api/operator/monitors', 'POST', { name: 'Maintenance ' + kind, kind, ...target })).json();
      const monitor = added.monitors.at(-1);
      const path = '/api/operator/monitors/' + monitor.id;
      const credential = kind === 'heartbeat' ? (await (await request('a.example', path + '/heartbeat-secret', 'POST')).json()).secret : null;
      const receipt = () => request('a.example', '/heartbeat', 'POST', undefined, credential);
      if (credential) await receipt(); else await tick(base);
      const before = [deliveries.length, webhooks.length];
      assert.equal((await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 180_000 })).status, 200);
      outcome = 503;
      await tick(base + 60_000); await tick(base + 120_000);
      let state = await (await request('a.example', '/api/operator')).json();
      assert.equal(state.monitor.state, 'maintenance');
      assert.equal(state.monitor.lastResult.outcome, 'maintenance');
      assert.deepEqual([deliveries.length, webhooks.length], before, kind + ' Maintenance failure suppresses both paths');
      if (credential) { now = base + 130_000; await receipt(); }
      await tick(base + 180_000);
      if (credential) assert.equal((await (await request('a.example', '/api/operator')).json()).monitor.state, 'up', 'fresh receipt survives expiry');
      await tick(base + 240_000);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1), kind + ' opens only after Maintenance');
      const opening = deliveries.at(-1);
      assert.equal(opening.transition, 'opened');
      await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 600_000 });
      outcome = 204;
      for (const at of [base + 300_000, base + 360_000]) { now = at; if (credential) await receipt(); else await tick(at); }
      state = await (await request('a.example', '/api/operator')).json();
      assert.equal(state.incidents.find(incident => incident.id === opening.incident.id).closedAt, null);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1), kind + ' Maintenance recovery suppresses both paths');
      await request('a.example', path + '/maintenance', 'DELETE');
      now = base + 420_000; if (credential) await receipt(); else await tick(now);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1), 'first post-window success cannot recover');
      now = base + 480_000; if (credential) await receipt(); else await tick(now);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 2), kind + ' recovers once after Maintenance');
      assert.equal(deliveries.at(-1).incident.id, opening.incident.id);
      assert.equal(deliveries.at(-1).transition, 'recovered');
      await request('a.example', path, 'DELETE');
    }
    for (const kind of ['http', 'tcp']) {
      const base = now + 60_000;
      now = base; outcome = 503;
      const target = kind === 'http' ? { url: 'https://target.example/' } : { hostname: 'db.example', port: 5432 };
      const added = await (await request('a.example', '/api/operator/monitors', 'POST', { name: 'Overlap ' + kind, kind, ...target })).json();
      const path = '/api/operator/monitors/' + added.monitors.at(-1).id;
      const before = [deliveries.length, webhooks.length];
      overlapAction = async () => {
        overlapAction = undefined;
        now = base + 1_000;
        await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 5_000 });
        now = base + 2_000;
        await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 3_000 });
        now = base + 2_500;
        await request('a.example', path + '/maintenance', 'DELETE');
      };
      await tick(base);
      let current = await (await request('a.example', '/api/operator')).json();
      assert.deepEqual(current.monitor.lastResult, { at: base, outcome: 'maintenance' });
      assert.deepEqual([deliveries.length, webhooks.length], before, kind + ' completed window overlap suppresses both paths');
      await tick(base + 60_000);
      assert.deepEqual([deliveries.length, webhooks.length], before, 'overlap does not seed failure counts');
      await tick(base + 120_000);
      const incident = deliveries.at(-1).incident;
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1));
      now = base + 179_000;
      await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 185_000 });
      outcome = 204;
      let expiredWindow = 'not evaluated';
      overlapAction = async () => {
        overlapAction = undefined;
        now = base + 181_000;
        await request('a.example', path + '/maintenance', 'PUT', { endsAt: base + 182_000 });
        now = base + 182_000;
        expiredWindow = (await (await request('a.example', '/api/operator')).json()).monitor.maintenance;
      };
      await tick(base + 180_000);
      assert.equal(expiredWindow, null);
      current = await (await request('a.example', '/api/operator')).json();
      assert.deepEqual(current.monitor.lastResult, { at: base + 180_000, outcome: 'maintenance' });
      assert.equal(current.incidents.find(candidate => candidate.id === incident.id).closedAt, null);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1), kind + ' overlap after replacement expiry freezes both deliveries');
      await tick(base + 240_000);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 1), 'overlap does not seed recovery counts');
      await tick(base + 300_000);
      assert.deepEqual([deliveries.length, webhooks.length], before.map(n => n + 2));
      assert.equal(deliveries.at(-1).incident.id, incident.id);
      assert.equal(deliveries.at(-1).transition, 'recovered');
      await request('a.example', path, 'DELETE');
    }
    // A delivery already submitted before declaration cannot be recalled; a later hook must still be suppressed.
    now += 60_000; outcome = 503;
    const pending = await (await request('a.example', '/api/operator/monitors', 'POST', { name: 'Committed before window', url: 'https://target.example/', failureThreshold: 1 })).json();
    const pendingId = pending.monitors.at(-1).id;
    const hookCount = deliveries.length;
    holdWebhook = true;
    const submitted = new Promise(resolve => { webhookStarted = resolve; });
    const dispatch = tick(now);
    await submitted;
    await request('a.example', '/api/operator/monitors/' + pendingId + '/maintenance', 'PUT', { endsAt: now + 180_000 });
    releaseWebhook();
    await dispatch;
    holdWebhook = false;
    assert.equal(deliveries.length, hookCount, 'a hook waiting behind an earlier webhook cannot start during Maintenance');
    console.log('PASS packed irisbeat@0.1.0: reproducible artifact, pinned integrity, consumer typecheck, isolated scheduling/Incidents, HTTP/TCP/heartbeat hooks, failure isolation, webhooks rotated tenant credentials and three-kind Maintenance suppression and HTTP/TCP boundary overlap of both delivery paths');
  } finally { await mf.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
