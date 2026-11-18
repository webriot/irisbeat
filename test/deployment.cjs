// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, symlinkSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { version } = require('../package.json');
const { experimental_patchConfig, unstable_readConfig } = require('wrangler');
const project = process.cwd();
const localRequire = createRequire(join(project, 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');
(async () => {
  const artifact = `irisbeat-${version}-source.tar.gz`;
  const manifest = JSON.parse(readFileSync('dist/release.json'));
  assert.equal(createHash('sha256').update(readFileSync('dist/' + artifact)).digest('hex'), manifest.sha256[artifact]);
  mkdirSync('.tmp', { recursive: true });
  const temporary = mkdtempSync(join(project, '.tmp/deployment-'));
  let mf;
  try {
    execFileSync('tar', ['-xzf', join(project, 'dist', artifact), '-C', temporary]);
    const source = join(temporary, `irisbeat-${version}`);
    // Share the lockfile-installed toolchain rather than copying dependencies on a constrained machine.
    assert.equal(readFileSync(join(source, 'package-lock.json'), 'utf8'), readFileSync('package-lock.json', 'utf8'));
    symlinkSync(join(project, 'node_modules'), join(source, 'node_modules'), 'dir');
    const monitoringName = 'irisbeat-smoke';
    const deliveryName = monitoringName + '-delivery';
    const queueName = monitoringName + '-notifications';
    const dlqName = queueName + '-dead-letter';
    const monitoringPath = join(source, 'wrangler.jsonc');
    const deliveryPath = join(source, 'wrangler.delivery.jsonc');
    experimental_patchConfig(monitoringPath, { queues: { producers: [{ queue: queueName }] } }, false);
    experimental_patchConfig(deliveryPath, {
      queues: { consumers: [{ queue: queueName }], producers: [{ queue: dlqName }] },
      services: [{ service: monitoringName }],
    }, false);
    const producerConfig = unstable_readConfig({ config: monitoringPath });
    const consumerConfig = unstable_readConfig({ config: deliveryPath });
    assert.equal(consumerConfig.observability.enabled, true, 'delivery keeps Workers Logs');
    assert.equal(consumerConfig.observability.traces.enabled, false, 'delivery omits credential-bearing fetch spans');
    for (const [name, config] of [[monitoringName, producerConfig], [deliveryName, consumerConfig]]) {
      execFileSync(join(project, 'node_modules/.bin/wrangler'), [
        'deploy', '--dry-run', '--config', config.configPath, '--name', name,
        '--outdir', join(temporary, name + '-build'),
      ], { cwd: source, stdio: 'pipe' });
    }
    const [queueProducer] = producerConfig.queues.producers;
    const [queueConsumer] = consumerConfig.queues.consumers;
    const [dlqProducer] = consumerConfig.queues.producers;
    const [deliveryService] = consumerConfig.services;
    const [recovery] = consumerConfig.durable_objects.bindings;
    assert.equal(queueConsumer.dead_letter_queue, undefined, 'source jobs must not be transferred with their full bodies');
    assert.ok(consumerConfig.migrations.some(migration => migration.new_sqlite_classes?.includes(recovery.class_name)));
    const delivery = (await build({ entryPoints: [join(source, 'src/notification-delivery.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] })).outputFiles[0].text;
    const script = (await build({ stdin: { contents: `
      import worker from './src/index.ts';
      export { MonitoringContext, NotificationDelivery } from './src/index.ts';
      let now = ${Date.UTC(2026, 10, 14)};
      Date.now = () => now;
      export default {
        async fetch(request, env) {
          now = Number(request.headers.get('x-acceptance-time'));
          if (new URL(request.url).pathname === '/__acceptance_tick') {
            await worker.scheduled({ scheduledTime: now, cron: '* * * * *' }, env);
            return new Response(null, { status: 204 });
          }
          return worker.fetch(request, env);
        },
        scheduled(controller, env) { now = controller.scheduledTime; return worker.scheduled(controller, env); }
      };`, resolveDir: source }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], plugins: [{
      name: 'controlled-tcp-target',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'target' }));
        builder.onLoad({ filter: /.*/, namespace: 'target' }, () => ({ contents: `export function connect(address) { return {
          opened: fetch('https://tcp-target.example/' + address.hostname + '/' + address.port).then(r => { if (!r.ok) throw new Error('refused'); }),
          closed: Promise.resolve(), close: async () => {}
        }; }` }));
      },
    }] })).outputFiles[0].text;
    let outcome = 503;
    const alerts = [], targets = [];
    const secret = randomBytes(32).toString('hex');
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [
      { name: monitoringName, modules: true, script, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: secret }, durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { [queueProducer.binding]: queueProducer.queue },
        outboundService: request => {
          const host = new URL(request.url).hostname;
          assert.ok(['http-target.example', 'tcp-target.example'].includes(host), 'all targets are substituted');
          targets.push(host); return new Response(null, { status: outcome });
        },
      },
      { name: deliveryName, modules: true, script: delivery, compatibilityDate: '2026-11-18',
        durableObjects: { [recovery.name]: { className: recovery.class_name, useSQLite: true } },
        queueConsumers: { [queueConsumer.queue]: {
          maxBatchTimeout: 0.1, maxRetries: queueConsumer.max_retries,
        } },
        queueProducers: { [dlqProducer.binding]: dlqProducer.queue },
        serviceBindings: { [deliveryService.binding]: { name: deliveryService.service, entrypoint: deliveryService.entrypoint } },
        outboundService: async request => {
          assert.equal(request.url, 'https://webhook.example/controlled');
          alerts.push(await request.json()); return new Response(null, { status: 204 });
        },
      },
    ] }));
    async function waitForAlerts(count) {
      const deadline = Date.now() + 5000;
      while (alerts.length < count) {
        assert.ok(Date.now() < deadline, 'timed out waiting for Queue delivery');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(alerts.length, count);
    }
    let now = Date.UTC(2026, 10, 14);
    const start = now;
    const request = (path, method = 'GET', body, token = secret) => mf.dispatchFetch('https://personal.example' + path, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-acceptance-time': String(now) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const tick = async offset => { now = start + offset; assert.equal((await request('/__acceptance_tick')).status, 204); };
    const status = async (path = '/api/operator') => (await request(path)).json();
    assert.equal((await request('/api/operator', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/api/operator', 'PUT', { pageName: 'Forbidden' }, 'wrong')).status, 401);
    assert.equal((await request('/api/operator', 'PUT', { pageName: 'Personal acceptance' })).status, 200);
    await request('/api/operator/webhook', 'PUT', { url: 'https://webhook.example/controlled' });
    for (const configuration of [
      { name: 'HTTP', kind: 'http', url: 'https://http-target.example/controlled' },
      { name: 'TCP', kind: 'tcp', hostname: 'controlled.example', port: 5432 },
      { name: 'Producer', kind: 'heartbeat', silenceSeconds: 180 },
    ]) assert.equal((await request('/api/operator/monitors', 'POST', configuration)).status, 201);
    const { monitors, destinations } = await status();
    for (const monitor of monitors) {
      assert.equal((await request('/api/operator/monitors/' + monitor.id, 'PATCH', { destinationIds: [destinations[0].id] })).status, 200);
    }
    const heartbeat = '/heartbeat/' + monitors[2].id;
    assert.equal((await request(heartbeat, 'POST', undefined, 'wrong')).status, 401);
    assert.equal((await request(heartbeat, 'POST')).status, 204);
    const html = await (await request('/', 'GET', undefined, '')).text();
    assert.ok(html.includes('Personal acceptance'));
    assert.ok(html.includes('irisbeat-0.2.2-source.tar.gz'), 'network users can obtain Corresponding Source after publication');
    new (require('node:vm').Script)(await (await request('/operator.js')).text());
    for (const publicBody of [html, JSON.stringify(await status('/api/status'))]) {
      for (const privateValue of [secret, 'http-target.example', 'controlled.example', 'webhook.example']) assert.ok(!publicBody.includes(privateValue));
    }
    await tick(60_000); await tick(120_000); await tick(180_000);
    assert.equal(targets.filter(host => host === 'http-target.example').length, 3);
    assert.equal(targets.filter(host => host === 'tcp-target.example').length, 3);
    assert.equal((await status()).incidents.length, 3);
    await waitForAlerts(3);
    assert.deepEqual(alerts.map(row => row.text.split('\n')[0]).sort(), ['`HTTP` · Incident opened', '`Producer` · Incident opened', '`TCP` · Incident opened']);
    const paths = monitors.map(monitor => '/api/operator/monitors/' + monitor.id);
    for (const path of paths) assert.equal((await request(path + '/maintenance', 'PUT', { endsAt: start + 600_000 })).status, 200);
    outcome = 204;
    await tick(240_000); await request(heartbeat, 'POST');
    assert.equal(alerts.length, 3);
    const maintained = await status();
    assert.ok(maintained.monitors.every(monitor => monitor.state === 'maintenance'));
    assert.ok(maintained.incidents.every(incident => incident.closedAt === null));
    assert.ok(maintained.monitors.every(monitor => monitor.history.days.at(-1).maintenance > 0));
    for (const path of paths) await request(path + '/maintenance', 'DELETE');
    await tick(300_000); await request(heartbeat, 'POST');
    assert.equal(alerts.length, 3, 'one healthy observation cannot recover');
    await tick(360_000); await request(heartbeat, 'POST');
    const recovered = await status();
    await waitForAlerts(6);
    assert.ok(recovered.incidents.every(incident => incident.closedAt !== null));
    for (const monitor of recovered.monitors) {
      assert.equal(monitor.history.days.length, 90);
      assert.ok(monitor.history.percentage > 0 && monitor.history.percentage < 100);
    }
    await request(paths[0], 'PATCH', { published: false });
    assert.equal((await status('/api/status')).monitors.length, 2);
    await tick(420_000);
    assert.equal(targets.filter(host => host === 'http-target.example').length, 7, 'private Monitor still checks');
    await request(paths[0], 'DELETE');
    assert.ok((await status()).incidents.some(incident => incident.monitorId === monitors[0].id), 'deletion retains operator Incidents');
    assert.ok(!(await status('/api/status')).incidents.some(incident => incident.monitorId === monitors[0].id));
    console.log('PASS exact-source personal workerd smoke: named producer and consumer dry runs, matched Queue and service binding, secret guards, named anonymous ledger/source, HTTP/TCP/Heartbeat, Maintenance/history, opening/recovery webhooks, publication and retained Incidents; no live deployment');
  } finally {
    if (mf) await mf.dispose();
    rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
