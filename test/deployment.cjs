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
    const origin = 'https://personal.example';
    experimental_patchConfig(monitoringPath, {
      queues: { producers: [{ queue: queueName }] },
      vars: { NOTIFICATION_PUBLIC_ORIGIN: origin },
      services: [{ binding: 'NOTIFICATION_EMAIL', service: deliveryName, entrypoint: 'NotificationEmailCapability' }],
    }, false);
    experimental_patchConfig(deliveryPath, {
      queues: { consumers: [{ queue: queueName }], producers: [{ queue: dlqName }, { queue: queueName }] },
      vars: { EMAIL_FROM: 'alerts@sender.example' },
      send_email: [{ name: 'EMAIL' }],
      services: [{ service: monitoringName }],
    }, false);
    const producerConfig = unstable_readConfig({ config: monitoringPath });
    const consumerConfig = unstable_readConfig({ config: deliveryPath });
    assert.equal(consumerConfig.observability.enabled, true, 'delivery keeps Workers Logs');
    assert.equal(consumerConfig.observability.traces.enabled, false, 'delivery omits credential-bearing fetch spans');
    const deliveryModules = ['notification-delivery', 'notification-recovery', 'notification-content',
      'email-confirmation-transport', 'email-transport', 'webhook-transport'];
    for (const [name, config] of [[monitoringName, producerConfig], [deliveryName, consumerConfig]]) {
      const outdir = join(temporary, name + '-build');
      execFileSync(join(project, 'node_modules/.bin/wrangler'), [
        'deploy', '--dry-run', '--config', config.configPath, '--name', name,
        '--outdir', outdir, '--metafile',
      ], { cwd: source, stdio: 'pipe' });
      const { outputs } = JSON.parse(readFileSync(join(outdir, 'bundle-meta.json'), 'utf8'));
      const emittedModules = Object.values(outputs).flatMap(output =>
        Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file));
      for (const module of deliveryModules) {
        assert.equal(emittedModules.some(file => file.endsWith('/' + module + '.ts')), name === deliveryName,
          module + ' belongs exclusively to the delivery bundle');
      }
    }
    assert.deepEqual(producerConfig.analytics_engine_datasets.map(({ binding, dataset }) => ({ binding, dataset })),
      [{ binding: 'AVAILABILITY_HISTORY', dataset: 'irisbeat_availability' }]);
    assert.ok(producerConfig.secrets.required.includes('AVAILABILITY_API_TOKEN'));
    assert.equal(producerConfig.keep_vars, true);
    const [queueProducer] = producerConfig.queues.producers;
    const [queueConsumer] = consumerConfig.queues.consumers;
    const deliveryProducers = Object.fromEntries(consumerConfig.queues.producers.map(({ binding, queue }) => [binding, queue]));
    const [deliveryService] = consumerConfig.services;
    const [emailService] = producerConfig.services;
    const serviceTarget = ({ service: name, entrypoint }) => ({ name, entrypoint });
    assert.deepEqual(deliveryProducers, { NOTIFICATION_DLQ: dlqName, NOTIFICATION_HANDOFF: queueName });
    assert.equal(queueProducer.binding, 'NOTIFICATION_QUEUE');
    assert.equal(queueProducer.queue, queueConsumer.queue);
    assert.equal(queueConsumer.max_retries, 10);
    assert.deepEqual(producerConfig.triggers.crons, ['* * * * *']);
    assert.deepEqual(producerConfig.queues.consumers ?? [], []);
    assert.deepEqual(consumerConfig.triggers.crons ?? [], []);
    assert.equal(consumerConfig.workers_dev, false);
    assert.equal(consumerConfig.preview_urls, false);
    assert.deepEqual(serviceTarget(deliveryService), { name: monitoringName, entrypoint: 'NotificationDelivery' });
    assert.deepEqual(serviceTarget(emailService), { name: deliveryName, entrypoint: 'NotificationEmailCapability' });
    const [recovery] = consumerConfig.durable_objects.bindings;
    assert.equal(queueConsumer.dead_letter_queue, undefined, 'source jobs must not be transferred with their full bodies');
    assert.ok(consumerConfig.migrations.some(migration => migration.new_sqlite_classes?.includes(recovery.class_name)));
    const delivery = readFileSync(join(temporary, deliveryName + '-build', 'notification-delivery.js'), 'utf8');
    const script = (await build({ stdin: { contents: `
      import worker, { MonitoringContext as EngineContext } from './src/index.ts';
      export { NotificationDelivery } from './src/index.ts';
      import { availabilityFixture } from ${JSON.stringify(join(project, 'test/availability-fixture.ts'))};
      const analytics = availabilityFixture();
      export class MonitoringContext extends EngineContext {
        constructor(ctx, env) { super(ctx, { ...env, ...analytics.bindings }); }
      }
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
    mf = new Miniflare(convertV4MiniflareOptions({ unsafeLocalExplorer: true, workers: [
      { name: monitoringName, modules: true, script, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: secret, STATUS_RENDER_INTERVAL_SECONDS: "0", ...producerConfig.vars },
        serviceBindings: { [emailService.binding]: serviceTarget(emailService) },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { [queueProducer.binding]: queueProducer.queue },
        outboundService: request => {
          const host = new URL(request.url).hostname;
          assert.ok(['http-target.example', 'tcp-target.example'].includes(host), 'all targets are substituted');
          targets.push(host); return new Response(null, { status: outcome });
        },
      },
      { name: deliveryName, modules: true, script: delivery, compatibilityDate: '2026-11-18',
        email: { send_email: consumerConfig.send_email }, bindings: consumerConfig.vars,
        durableObjects: { [recovery.name]: { className: recovery.class_name, useSQLite: true } },
        queueConsumers: { [queueConsumer.queue]: {
          maxBatchTimeout: 0.1, maxRetries: queueConsumer.max_retries,
        } },
        queueProducers: deliveryProducers,
        serviceBindings: { [deliveryService.binding]: serviceTarget(deliveryService) },
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
    assert.ok(html.includes(`/releases/download/v${version}/irisbeat-${version}-source.tar.gz`), 'network users can obtain Corresponding Source after publication');
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
    await waitForAlerts(6);
    assert.ok(alerts.slice(3).every(row => row.text.split('\n')[0].endsWith(' · Maintenance started')));
    outcome = 204;
    await tick(240_000); await request(heartbeat, 'POST');
    assert.equal(alerts.length, 6);
    const maintained = await status();
    assert.ok(maintained.monitors.every(monitor => monitor.state === 'maintenance'));
    assert.ok(maintained.incidents.every(incident => incident.closedAt === null));
    assert.ok(maintained.monitors.every(monitor => monitor.history.days.at(-1).maintenance > 0));
    for (const path of paths) await request(path + '/maintenance', 'DELETE');
    await waitForAlerts(9);
    assert.ok(alerts.slice(6).every(row => row.text.split('\n')[0].endsWith(' · Maintenance ended early')));
    await tick(300_000); await request(heartbeat, 'POST');
    assert.equal(alerts.length, 9, 'one healthy observation cannot recover');
    await tick(360_000); await request(heartbeat, 'POST');
    const recovered = await status();
    await waitForAlerts(12);
    assert.ok(alerts.slice(9).every(row => row.text.split('\n')[0].endsWith(' · Incident recovered')));
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
    const inbox = 'ops@example.net';
    assert.equal((await request('/api/operator/destinations', 'POST', { channel: 'email', address: inbox })).status, 201);
    const capture = '/cdn-cgi/local/explorer/api/local/email/sending?worker=' + deliveryName;
    const capturedMail = async (suffix = '') => {
      const response = await mf.dispatchFetch(new URL(capture + suffix, await mf.ready));
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    async function mailWithSubject(subject) {
      const deadline = Date.now() + 5000;
      let mail;
      while (!(mail = (await capturedMail()).find(message => message.to.includes(inbox) && message.subject === subject))) {
        assert.ok(Date.now() < deadline, 'timed out waiting for ' + subject);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return capturedMail('&email_id=' + encodeURIComponent(mail.messageId));
    }
    const recipientPost = link => mf.dispatchFetch(link.origin + link.pathname, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-acceptance-time': String(now) },
      body: new URLSearchParams({ token: link.hash.slice(1) }),
    });
    const confirmation = await mailWithSubject('Confirm Irisbeat email notifications');
    const link = new URL(confirmation.text.match(/https:\/\/[^\s]+/)[0]);
    assert.equal(link.origin + link.pathname, origin + '/notifications/confirm');
    assert.equal((await recipientPost(link)).status, 200);
    const email = (await status()).destinations.find(destination => destination.address === inbox);
    assert.ok(email.confirmed);
    assert.equal((await request(paths[1], 'PATCH', { destinationIds: [email.id, destinations[0].id] })).status, 200);
    assert.equal((await capturedMail()).length, 1, 'confirmation and selection do not replay history');

    const submissionStarted = Date.now();
    assert.equal((await request(paths[1] + '/maintenance', 'PUT', { endsAt: start + 600_000 })).status, 200);
    await waitForAlerts(13);
    const mail = await mailWithSubject('Irisbeat: Maintenance started');
    assert.deepEqual(mail.to, [inbox]);
    assert.equal(mail.from, consumerConfig.vars.EMAIL_FROM);
    const occurredAt = new Date(now).toISOString();
    const withdrawal = new URL(mail.text.match(/https:\/\/[^\s]+/)[0]);
    assert.equal(withdrawal.origin + withdrawal.pathname, origin + '/notifications/unsubscribe');
    assert.ok(mail.text.includes(occurredAt) && mail.html.includes(occurredAt));
    assert.ok(mail.html.includes('href="' + withdrawal.href + '"'));
    assert.ok(alerts.at(-1).text.includes(occurredAt));
    const deadline = Date.now() + 5000;
    for (;;) {
      const results = (await status()).destinations.map(destination => destination.latestSubmission);
      if (results.every(result => result?.status === 'accepted' && result.at >= submissionStarted)) break;
      assert.ok(Date.now() < deadline, 'timed out waiting for current Settings results');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const publicResponse = await request('/api/status', 'GET', undefined, '');
    assert.doesNotMatch(await publicResponse.text(), /ops@example\.net|webhook\.example|destinationIds/);
    assert.equal((await recipientPost(withdrawal)).status, 200);
    const withdrawn = await status();
    assert.deepEqual(withdrawn.destinations.map(destination => destination.id), [destinations[0].id]);
    assert.deepEqual(withdrawn.monitors.find(monitor => monitor.id === monitors[1].id).destinationIds, [destinations[0].id]);
    console.log('PASS exact-source personal deployment: isolated Wrangler bundles, Queue and service wiring, HTTP/TCP/Heartbeat, mixed Maintenance and Incident delivery, native email consent and withdrawal, Settings results and public privacy');
  } finally {
    if (mf) await mf.dispose();
    rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
