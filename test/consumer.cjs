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
  let now = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'consumer', modules: true, script, compatibilityDate: '2026-11-13', durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } }, outboundService: async request => {
    if (request.url.startsWith('https://delivery.example/')) { deliveries.push(await request.json()); return new Response(null, { status: deliveryFails ? 503 : 204 }); }
    if (request.url.startsWith('https://webhook.example/')) { webhooks.push(await request.json()); return new Response(null, { status: 204 }); }
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
    console.log('PASS packed irisbeat@0.1.0: reproducible artifact, pinned integrity, consumer typecheck, isolated scheduling/Incidents, HTTP/TCP/heartbeat hooks, failure isolation, webhooks and rotated tenant credentials');
  } finally { await mf.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
