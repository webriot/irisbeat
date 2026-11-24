// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const localRequire = createRequire(join(process.cwd(), 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Log, LogLevel, Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');

async function bundle(contents, resolveDir) {
  return (await build({
    stdin: { contents, resolveDir, loader: 'ts' },
    nodePaths: [join(process.cwd(), 'node_modules')],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', 'cloudflare:sockets'],
  })).outputFiles[0].text;
}

async function deliveryBundles(source = './src', hasRecovery = true) {
  const installed = source === 'irisbeat';
  const resolveDir = installed ? join(process.cwd(), 'test/consumer') : process.cwd();
  const engineImport = JSON.stringify(installed ? 'irisbeat' : source + '/index.ts');
  const deliveryImport = JSON.stringify(installed ? 'irisbeat/notification-delivery' : source + '/notification-delivery.ts');
  const monitoring = await bundle(`
    import personal, { createHostedWorker, MonitoringContext as EngineContext } from ${engineImport};
    import { NotificationDelivery as EngineDelivery } from ${engineImport};
    export class NotificationDelivery extends EngineDelivery {
      async resolveAlert(job) {
        const response = await this.env.GATE.fetch('https://test.example/resolve', {
          method: 'POST', body: JSON.stringify(job.deliveryId),
        });
        if (!response.ok) throw new Error('Injected eligibility outage');
        return super.resolveAlert(job);
      }
      async markConfirmationSubmitted(job) {
        const response = await this.env.GATE.fetch('https://test.example/mark-confirmation', {
          method: 'POST', body: JSON.stringify(job),
        });
        if (!response.ok) throw new Error('Injected confirmation bookkeeping failure');
        return super.markConfirmationSubmitted(job);
      }
      async reportSubmission(job, report) {
        const response = await this.env.GATE.fetch('https://test.example/report', {
          method: 'POST', body: JSON.stringify({ job, report }),
        });
        if (!response.ok) throw new Error('Injected result RPC failure');
        return super.reportSubmission(job, report);
      }
    }
    const realNow = Date.now;
    const realUuid = crypto.randomUUID.bind(crypto);
    let testTime, testUuid;
    Date.now = () => testTime ?? realNow();
    crypto.randomUUID = () => testUuid ?? realUuid();
    export class MonitoringContext extends EngineContext {
      restartForTest() { this.ctx.abort('Local Queue restart drill'); }
      setTestTime(at, uuid) { testTime = at; testUuid = uuid; }
      outboundStartTime(scheduledAt) { return scheduledAt; }
    }
    function policy(revision) {
      return { paused: Number(revision) % 2 === 1, policyRevision: Number(revision) };
    }
    const hosted = createHostedWorker({
      contractVersion: '1',
      resolve(request) {
        const url = new URL(request.url);
        const revision = url.searchParams.get('test-policy-revision');
        const token = request.headers.get('authorization');
        const id = url.hostname === 'recipient.example' ? 'mixed-pause.example' : url.hostname;
        return {
          id, monitorLimit: 10,
          permission: token === 'Bearer test-installation-secret' ? 'editor' : token === 'Bearer reader' ? 'reader' : null,
          notificationOrigin: id === 'mixed-pause.example' ? 'https://recipient.example'
            : url.hostname === 'no-email.example' ? undefined : url.origin,
          ...(revision === null ? {} : policy(revision)),
        };
      },
      contexts: env => [env.testContext],
    });
    const systemNow = Date.now;
    let wallTime;
    Date.now = () => wallTime ?? systemNow();
    export default {
      async fetch(request, env) {
        const wall = request.headers.get('x-test-wall-time');
        wallTime = wall === null ? undefined : Number(wall);
        const url = new URL(request.url);
        const app = url.hostname === 'personal.example' ? personal : hosted;
        if (url.pathname === '/test-clock') {
          const id = url.hostname === 'personal.example' ? 'personal' : url.hostname;
          const at = Number(url.searchParams.get('at')) || undefined;
          return env.MONITORING.getByName(id).setTestTime(at, url.searchParams.get('uuid')).then(() => new Response(null, { status: 204 }));
        }
        if (url.pathname === '/test-restart') {
          const id = env.MONITORING.idFromString(url.searchParams.get('context'));
          await env.MONITORING.get(id).restartForTest().catch(() => {});
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/test-tick') {
          const revision = url.searchParams.get('test-policy-revision');
          const testContext = url.hostname === 'legacy-tenant.example'
            ? { id: url.hostname, notificationOrigin: 'https://legacy-tenant.example' }
            : revision === null ? url.hostname : { id: url.hostname, ...policy(revision) };
          return app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) }, { ...env, testContext }).then(() => new Response(null, { status: 204 }));
        }
        return app.fetch(request, env);
      },
    };`, resolveDir);
  const recovery = hasRecovery ? `
    import { NotificationRecovery as Recovery } from ${deliveryImport};
    export class NotificationRecovery extends Recovery {
      constructor(ctx, env) { super(ctx, faultBindings(env)); }
      async deliver(job, brokerAttempt, queuedAt) {
        if (brokerAttempt >= 11) {
          const response = await this.env.GATE.fetch('https://test.example/recovery-admission', {
            method: 'POST', body: JSON.stringify(job.deliveryId),
          });
          if (!response.ok) throw new Error('Injected Recovery RPC outage');
        }
        return super.deliver(job, brokerAttempt, queuedAt);
      }
    }
    function faultBindings(env) {
      const EMAIL = env.EMAIL && { async send(mail) {
        const response = await env.GATE.fetch('https://test.example/email-send', {
          method: 'POST', body: JSON.stringify(mail.to),
        });
        if (!response.ok) throw Object.assign(new Error('sensitive provider response'), { code: await response.text() });
        return env.EMAIL.send(mail);
      } };
      return { ...env, EMAIL, NOTIFICATION_DLQ: { async send(letter) {
        const response = await env.GATE.fetch('https://test.example/dlq-write', { method: 'POST', body: JSON.stringify(letter) });
        if (!response.ok) throw new Error('Injected DLQ write failure');
        await env.NOTIFICATION_DLQ.send(letter);
      } } };
    }
  ` : '';
  const consumer = await bundle(`
    import delivery from ${deliveryImport};
    export { NotificationEmailCapability } from ${deliveryImport};
    ${recovery}
    export default {
      async queue(batch, env, ctx) {
        if (batch.queue === 'dead-letters') {
          await env.GATE.fetch('https://test.example/dead-letters', { method: 'POST', body: JSON.stringify(batch.messages.map(message => message.body)) });
          return;
        }
        const messages = batch.messages.map(({ id, body, attempts, timestamp }) => ({ id, body, attempts, timestamp }));
        const overrides = await (await env.GATE.fetch('https://test.example/batch', { method: 'POST', body: JSON.stringify(messages) })).json();
        const actions = [];
        await delivery.queue({ ...batch, messages: batch.messages.map((message, index) => ({
          ...messages[index],
          ...(overrides[index]?.attempts === undefined ? {} : { attempts: overrides[index].attempts }),
          ...(overrides[index]?.timestamp === undefined ? {} : { timestamp: new Date(overrides[index].timestamp) }),
          ack() { message.ack(); actions.push({ id: message.body.deliveryId, ack: true }); },
          retry(options) {
            actions.push({ id: message.body.deliveryId, retry: options });
            // Controlled messages drive exact attempts without waiting for long retry delays.
            if (overrides[index] && batch.queue !== 'final-notifications') message.ack();
            else message.retry(options);
          },
        })) }, env, ctx);
        await env.GATE.fetch('https://test.example/done', { method: 'POST', body: JSON.stringify(actions) });
      },
    };`, resolveDir);
  return { monitoring, consumer, hasRecovery };
}

async function main(runFixture, emailEnabled = true, upgrade, packageName) {
  const current = await deliveryBundles(packageName);
  if (packageName) console.log('Running both notification Workers from the installed engine exports');
  const batches = [], submissions = [], errors = [], actions = [], deadLetters = [];
  const controls = new Map();
  const providerStatuses = new Map();
  const sender = 'alerts@sender.example';
  const capturedTokens = new Set();
  let targetRequests = 0;
  let healthy = false;
  let holdBatch, holdProvider, heldEventTime, providerStartedAt;
  let completedBatches = 0;
  let heldProviderStatus = 403;
  const reportFaults = new Map();
  const retryReportGates = new Map();
  const recoveryFaults = new Map();
  const recoveryCalls = [];
  const confirmationFaults = new Map();
  const confirmationReports = [];
  const emailFaults = new Map();
  const emailCalls = [];
  const resolveFaults = new Map();
  const resolutionGates = new Map();
  const dlqFaults = new Set();
  const reportAttempts = [], dlqAttempts = [];
  const gate = async request => {
    const path = new URL(request.url).pathname;
    if (path === '/report') {
      const { job, report } = await request.json();
      reportAttempts.push(job.deliveryId);
      if (report.result.status === 'retrying') await retryReportGates.get(job.deliveryId);
      const remaining = reportFaults.get(job.deliveryId) ?? 0;
      if (remaining) {
        reportFaults.set(job.deliveryId, remaining - 1);
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/recovery-admission') {
      const deliveryId = await request.json();
      recoveryCalls.push(deliveryId);
      const remaining = recoveryFaults.get(deliveryId) ?? 0;
      if (remaining) recoveryFaults.set(deliveryId, remaining - 1);
      return new Response(null, { status: remaining ? 503 : 204 });
    }
    if (path === '/resolve') {
      const deliveryId = await request.json();
      const gate = resolutionGates.get(deliveryId);
      if (gate) {
        gate.enter();
        await gate.release;
      }
      const remaining = resolveFaults.get(deliveryId) ?? 0;
      if (remaining) resolveFaults.set(deliveryId, remaining - 1);
      return new Response(null, { status: remaining ? 503 : 204 });
    }
    if (path === '/mark-confirmation') {
      const identity = await request.json();
      confirmationReports.push(identity);
      const remaining = confirmationFaults.get(identity.deliveryId) ?? 0;
      if (remaining) confirmationFaults.set(identity.deliveryId, remaining - 1);
      return new Response(null, { status: remaining ? 503 : 204 });
    }
    if (path === '/email-send') {
      const address = await request.json();
      emailCalls.push(address);
      const code = emailFaults.get(address);
      emailFaults.delete(address);
      return code ? new Response(code, { status: 503 }) : new Response(null, { status: 204 });
    }
    if (path === '/dlq-write') {
      const { deliveryId } = await request.json();
      dlqAttempts.push(deliveryId);
      return new Response(null, { status: dlqFaults.has(deliveryId) ? 503 : 204 });
    }
    if (path === '/batch') {
      const messages = await request.json();
      batches.push(messages.map(message => message.body));
      await holdBatch;
      return Response.json(messages.map(message => {
        const control = controls.get(message.body.deliveryId);
        if (Array.isArray(control)) {
          const next = control.shift();
          if (!control.length) controls.delete(message.body.deliveryId);
          return next;
        }
        controls.delete(message.body.deliveryId);
        return control;
      }));
    }
    if (path === '/dead-letters') deadLetters.push(...await request.json());
    if (path === '/done') {
      actions.push(...await request.json());
      completedBatches++;
    }
    return new Response(null, { status: 204 });
  };
  let providerStatus = 204;
  const optionsFor = ({ monitoring, consumer, hasRecovery }) => ({
    ...(upgrade ? { durableObjectsPersist: upgrade.persist } : {}),
    unsafeLocalExplorer: emailEnabled,
    log: new Log(LogLevel.NONE),
    handleStructuredLogs: log => { if (log.level === 'error') errors.push(log.message); },
    workers: [
      { name: 'monitoring', modules: true, script: monitoring, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: 'test-installation-secret', STATUS_RENDER_INTERVAL_SECONDS: '0', NOTIFICATION_PUBLIC_ORIGIN: 'https://personal.example' },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { NOTIFICATION_QUEUE: 'notifications', FINAL_QUEUE: 'final-notifications' },
        serviceBindings: {
          GATE: gate, NOTIFICATION_EMAIL: { name: 'delivery', entrypoint: 'NotificationEmailCapability' },
        },
        outboundService: request => {
          assert.equal(request.url, 'https://internal.example:8443/target-secret');
          targetRequests++;
          return new Response(null, { status: healthy ? 204 : 503 });
        },
      },
      { name: 'delivery', modules: true, script: consumer, compatibilityDate: '2026-11-18',
        bindings: { EMAIL_FROM: sender },
        ...(emailEnabled ? { email: { send_email: [{ name: 'EMAIL' }] } } : {}),
        ...(hasRecovery ? { durableObjects: { NOTIFICATION_RECOVERY: { className: 'NotificationRecovery', useSQLite: true } } } : {}),
        queueConsumers: {
          notifications: { maxBatchTimeout: 0.1, maxRetries: 10 },
          'final-notifications': { maxBatchTimeout: 0.1, maxRetries: 0 },
          'dead-letters': { maxBatchTimeout: 0.1 },
        },
        queueProducers: { NOTIFICATION_DLQ: 'dead-letters', NOTIFICATION_HANDOFF: 'notifications' },
        serviceBindings: {
          NOTIFICATION_DELIVERY: { name: 'monitoring', entrypoint: 'NotificationDelivery' },
          GATE: gate,
        },
        outboundService: async request => {
          const submission = { url: request.url };
          submissions.push(submission);
          if (new URL(request.url).hostname === 'redirect.example') return new Response(null, { status: 204 });
          submission.payload = await request.json();
          const status = providerStatuses.get(request.url) ?? providerStatus;
          if (holdProvider && (!heldEventTime || submission.payload.text.includes(heldEventTime))) {
            providerStartedAt = performance.now();
            const fail = !!heldEventTime;
            await holdProvider;
            if (fail) return new Response(heldProviderStatus === 204 ? null : 'sensitive provider response', { status: heldProviderStatus });
          }
          return new Response(status === 204 ? null : 'sensitive provider response', {
            status, headers: { Location: 'https://redirect.example/secret' },
          });
        },
      },
    ],
  });
  const options = optionsFor(current);
  const mf = new Miniflare(convertV4MiniflareOptions(upgrade ? optionsFor(upgrade.old) : options));
  const captureEndpoint = '/cdn-cgi/local/explorer/api/local/email/sending?worker=delivery';
  async function capturedMail(query = '') {
    const response = await mf.dispatchFetch(new URL(captureEndpoint + query, await mf.ready));
    assert.equal(response.status, 200, 'Local Explorer email capture request');
    return (await response.json()).result;
  }

  async function confirmationLink(message, address) {
    const mail = await capturedMail('&email_id=' + encodeURIComponent(message.messageId));
    assert.deepEqual(mail.to, [address]);
    assert.equal(mail.from, sender);
    const href = mail.text?.match(/https:\/\/[^\s]+/)?.[0];
    assert.ok(typeof href === 'string', 'captured plain text contains a confirmation link');
    assert.ok(mail.html?.includes('href="' + href + '"'), 'captured HTML links to the same confirmation page');
    assert.ok(/^https:\/\/[a-z.-]+\/notifications\/confirm#[a-f0-9-]{36}$/.test(href), 'captured link has a confirmation fragment');
    const link = new URL(href);
    capturedTokens.add(link.hash.slice(1));
    return link;
  }

  let at = Date.now();
  const path = '/api/operator/destinations';
  const monitors = '/api/operator/monitors';
  let wallTime;
  const request = (host, endpoint, method = 'GET', value, headers = {}) => mf.dispatchFetch('https://' + host + endpoint, {
    method, headers: {
      authorization: 'Bearer test-installation-secret', 'content-type': 'application/json',
      ...(wallTime === undefined ? {} : { 'x-test-wall-time': String(wallTime) }),
      ...headers,
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  async function json(host, endpoint, method, value, expected = 200, headers) {
    const response = await request(host, endpoint, method, value, headers);
    assert.equal(response.status, expected, endpoint);
    return response.json();
  }
  async function tick(host, policyRevision) {
    const revision = policyRevision === undefined ? '' : '&test-policy-revision=' + policyRevision;
    assert.equal((await request(host, '/test-tick?at=' + at + revision)).status, 204);
    at += 60_000;
  }
  async function until(condition, timeout = 5000) {
    const deadline = Date.now() + timeout;
    let result;
    while (!(result = await condition())) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the Queue consumer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return result;
  }
  async function holdTransition(host, change, produce = () => tick(host)) {
    const priorBatches = batches.length;
    let release;
    holdBatch = new Promise(resolve => { release = resolve; });
    try {
      await produce();
      await until(() => batches.length > priorBatches);
      await change();
    } finally {
      release();
      holdBatch = undefined;
    }
    await until(() => completedBatches > priorBatches);
  }
  async function redeliver(producer, job) {
    const before = completedBatches;
    await producer.send(job);
    await until(() => completedBatches > before);
  }

  try {
    if (upgrade) {
      const hosts = ['personal.example', 'legacy-tenant.example'];
      const address = 'legacy-alert@example.net';
      const selected = [];
      const recipient = (link, origin = link.origin) => mf.dispatchFetch(origin + link.pathname, {
        method: 'POST', body: new URLSearchParams({ token: link.hash.slice(1) }),
      });
      for (const host of hosts) {
        const { destinations: [destination] } = await json(host, path, 'POST', { channel: 'email', address }, 201);
        const { destinations: [, webhook] } = await json(host, path, 'POST', { url: 'https://hooks.example/legacy' }, 201);
        const message = await until(async () => {
          if (completedBatches !== batches.length) return;
          return (await capturedMail()).find(capture => capture.to.includes(address) &&
            !selected.some(item => item.messageId === capture.messageId));
        });
        const link = await confirmationLink(message, address);
        assert.equal(link.host, host);
        assert.equal((await recipient(link)).status, 200);
        const { monitor } = await json(host, monitors, 'POST', {
          name: 'Existing Monitor', url: 'https://internal.example:8443/target-secret', failureThreshold: 1,
        }, 201);
        const snapshot = await json(host, monitors + '/' + monitor.id, 'PATCH', { destinationIds: [destination.id] });
        assert.equal(snapshot.destinations[0].confirmed, true);
        assert.deepEqual(snapshot.monitor.destinationIds, [destination.id]);
        selected.push({ destination, webhook, monitor, messageId: message.messageId });
      }
      await mf.setOptions(convertV4MiniflareOptions(options));

      const withdrawals = [];
      for (const [index, host] of hosts.entries()) {
        const { destination, monitor } = selected[index];
        const before = completedBatches;
        const openedAt = at;
        await tick(host);
        await until(() => completedBatches > before);
        assert.ok(batches.at(-1).some(job => job.destinationId === destination.id && job.monitorId === monitor.id &&
          job.event.kind === 'incident.opened'), 'the first Incident reached the native Queue consumer');
        const openings = (await capturedMail()).filter(message => message.to.includes(address) &&
          message.subject === 'Irisbeat: Incident opened');
        assert.equal(openings.length, index + 1, host + ' sends its first alert before any Operator request');
        const mail = await capturedMail('&email_id=' + encodeURIComponent(openings.find(message =>
          !withdrawals.some(item => item.messageId === message.messageId)).messageId));
        const href = mail.text.match(/https:\/\/[^\s]+/)?.[0];
        assert.ok(href && mail.html.includes('href="' + href + '"'));
        const link = new URL(href);
        assert.equal(link.origin + link.pathname, 'https://' + host + '/notifications/unsubscribe');
        assert.match(link.hash, /^#[a-f0-9-]{36}$/);
        withdrawals.push({ link, messageId: mail.messageId });
        const status = await json(host, '/api/status', 'GET', undefined, 200, { authorization: '' });
        assert.equal(status.incidents[0].openedAt, openedAt);
      }

      const [personal, hosted] = withdrawals;
      assert.equal((await recipient(hosted.link, personal.link.origin)).status, 400);
      assert.equal((await recipient(hosted.link)).status, 200);
      assert.equal((await recipient(hosted.link)).status, 400);
      const personalStatus = await json(hosts[0], '/api/operator');
      const [email, webhook] = personalStatus.destinations;
      assert.equal(email.confirmed, true);
      assert.equal(email.name, 'Email 1');
      assert.equal(email.id, selected[0].destination.id);
      assert.equal(webhook.name, 'Webhook 1');
      assert.equal(webhook.id, selected[0].webhook.id);
      assert.deepEqual(personalStatus.monitor.destinationIds, [selected[0].destination.id]);
      assert.equal((await request(hosts[0], path, 'POST', { url: 'https://hooks.example/duplicate', name: 'EMAIL 1' })).status, 409);
      const renamed = await json(hosts[0], path + '/' + email.id, 'PUT', { channel: 'email', address, name: 'Operations' });
      assert.equal(renamed.destinations[0].name, 'Operations');
      assert.equal(renamed.destinations[0].confirmed, true);
      assert.equal(renamed.destinations[0].id, email.id);
      assert.deepEqual(renamed.monitor.destinationIds, [email.id]);
      const hostedStatus = await json(hosts[1], '/api/operator');
      assert.deepEqual(hostedStatus.destinations.map(({ id, name }) => ({ id, name })), [{ id: selected[1].webhook.id, name: 'Webhook 1' }]);
      assert.deepEqual(hostedStatus.monitor.destinationIds, []);
      console.log('PASS confirmation-only Worker upgrade: first Incident email without Operator traffic and context-scoped withdrawal');
      return;
    }
    if (runFixture) {
      await runFixture((url, init) => mf.dispatchFetch(url, init), async address => {
        const message = await until(async () => (await capturedMail()).find(message => message.to.includes(address) &&
          message.subject === 'Confirm Irisbeat email notifications'));
        return (await confirmationLink(message, address)).href;
      }, async address => {
        const message = await until(async () => (await capturedMail()).find(message => message.to.includes(address) &&
          message.subject === 'Irisbeat: Maintenance started'));
        const mail = await capturedMail('&email_id=' + encodeURIComponent(message.messageId));
        const link = mail.text.match(/https:\/\/[^\s]+/)?.[0];
        assert.ok(link);
        return link;
      });
      return;
    }
    let producer = await mf.getQueueProducer('NOTIFICATION_QUEUE', 'monitoring');
    let deletePersonalMonitor;
    for (const host of ['personal.example', 'tenant.example']) {
      healthy = false;
      providerStatus = 204;
      const name = 'Main\nWebsite `@everyone <!channel> <@&123>` *bold*';
      const created = await json(host, monitors, 'POST', {
        name, url: 'https://internal.example:8443/target-secret', published: false, failureThreshold: 1, recoveryThreshold: 1,
      }, 201);
      const monitorPath = monitors + '/' + created.monitor.id;
      const slack = 'https://hooks.example/token';
      const discord = 'https://discord.com/api/webhooks/123/token';
      await json(host, path, 'POST', { url: slack }, 201);
      const { destinations } = await json(host, path, 'POST', { url: discord }, 201);
      const ids = destinations.map(destination => destination.id);
      const before = submissions.length;
      await tick(host);
      assert.equal((await json(host, '/api/operator')).incidents.length, 1);
      assert.deepEqual((await json(host, '/api/status')).incidents, []);
      await json(host, monitorPath, 'PATCH', { destinationIds: ids });
      healthy = true;
      const recoveredAt = at;
      await tick(host);
      await until(() => submissions.length === before + 2 && completedBatches === batches.length);
      const recoveryJobs = batches.at(-1);
      const accepted = (await json(host, path)).destinations.map(destination => destination.latestSubmission?.status);
      assert.deepEqual(accepted, ['accepted', 'accepted'], 'Settings data reports provider acceptance for each destination');
      assert.equal(recoveryJobs.length, 2);
      assert.equal(new Set(recoveryJobs.map(job => job.event.id)).size, 1);
      assert.equal(new Set(recoveryJobs.map(job => job.deliveryId)).size, 2);
      const [first, second] = submissions.slice(before).sort((a, b) => a.url.localeCompare(b.url));
      assert.equal(first.url, discord + '/slack');
      assert.equal(second.url, slack);
      for (const { payload } of [first, second]) {
        assert.match(payload.text, /Incident recovered/);
        assert.ok(payload.text.includes(new Date(recoveredAt).toISOString()));
        assert.doesNotMatch(payload.text, /@everyone|<!channel>|<@&123>|internal\.example|target-secret/);
      }
      for (const job of recoveryJobs) {
        assert.deepEqual(Object.keys(job).sort(), ['contextId', 'deliveryId', 'destinationId', 'event', 'generation', 'monitorId', 'pauseGeneration']);
        assert.deepEqual(Object.keys(job.event).sort(), ['at', 'id', 'incidentId', 'kind', 'monitorName', 'openedAt', 'order']);
      }
      assert.doesNotMatch(JSON.stringify(batches), /internal\.example|target-secret|hooks\.example|\/token/);

      if (host === 'tenant.example') {
        // Replay only the context ID of a job that just delivered while its selection is still active.
        const wrongContext = batches[0][0].contextId;
        assert.notEqual(recoveryJobs[0].contextId, wrongContext);
        const beforeReplay = completedBatches;
        await producer.send({ ...recoveryJobs[0], contextId: wrongContext });
        await until(() => completedBatches > beforeReplay);
        assert.equal(submissions.length, before + 2, 'changing only context ID rejects an otherwise eligible job');
      }

      // A no-op selection retains eligibility, while deselecting and reselecting does not.
      healthy = false;
      providerStatus = 307;
      await holdTransition(host, async () => {
        const committed = (await json(host, '/api/operator')).incidents;
        assert.equal(committed.filter(incident => incident.closedAt === null).length, 1);
        await json(host, monitorPath, 'PATCH', { destinationIds: [ids[1]] });
        await json(host, monitorPath, 'PATCH', { destinationIds: ids });
      });
      assert.deepEqual(submissions.slice(before + 2).map(item => item.url), [discord + '/slack'], 'a 307 never triggers a second outbound request');

      healthy = true;
      await holdTransition(host, async () => {
        await json(host, path + '/' + ids[0], 'PUT', { url: 'https://hooks.example/replaced' });
        await json(host, path + '/' + ids[1], 'DELETE');
        const { destinations: addedAgain } = await json(host, path, 'POST', { url: discord }, 201);
        await json(host, monitorPath, 'PATCH', { destinationIds: addedAgain.map(destination => destination.id) });
      });
      assert.equal(submissions.length, before + 3, 'replacement and re-addition cancel already queued jobs');

      if (host === 'personal.example') {
        deletePersonalMonitor = async () => {
          const beforeDeletion = submissions.length;
          healthy = false;
          await holdTransition(host, async () => {
            await json(host, monitorPath, 'DELETE');
          });
          assert.equal(submissions.length, beforeDeletion, 'deleting the Monitor cancels already queued jobs');
        };
      } else {
        const [destination, secondDestination] = (await json(host, '/api/operator')).destinations;
        await json(host, monitorPath, 'PATCH', { destinationIds: [destination.id] });
        healthy = false;
        providerStatus = 204;
        await holdTransition(host, async () => {
          assert.equal((await json(host, '/api/operator?test-policy-revision=1')).paused, true);
          healthy = true;
          await tick(host);
          assert.ok((await json(host, '/api/operator')).incidents.some(incident => incident.closedAt === null),
            'paused dispatch leaves the opening Incident unresolved');
          assert.equal((await json(host, '/api/operator?test-policy-revision=2')).paused, false);
        });
        assert.equal(submissions.length, before + 3, 'jobs held across a trusted pause and resume cannot submit');
        await tick(host);
        await until(() => submissions.length === before + 4 && completedBatches === batches.length);
        assert.match(submissions.at(-1).payload.text, /Incident recovered/, 'a fresh post-resume job delivers');

        healthy = false;
        providerStatus = 429;
        await json(host, monitorPath, 'PATCH', { destinationIds: [destination.id, secondDestination.id] });
        const beforeAttempt = completedBatches;
        const beforeSubmitted = submissions.length;
        let finishAttempt;
        holdProvider = new Promise(resolve => { finishAttempt = resolve; });
        try {
          await tick(host);
          await until(() => submissions.length === beforeSubmitted + 2);
          await tick(host, 3);
          assert.equal((await json(host, '/api/operator?test-policy-revision=2')).paused, true, 'a stale resume cannot override a scheduled pause');
          assert.equal(completedBatches, beforeAttempt, 'pause cannot recall a submission already in flight');
        } finally {
          finishAttempt();
          holdProvider = undefined;
        }
        await until(() => completedBatches > beforeAttempt);
        const [pausedJob, resumedJob] = batches.at(-1);
        assert.ok(actions.slice(-2).every(action => action.retry?.delaySeconds === 5));
        const priorSubmissions = submissions.length;
        const priorErrors = errors.length;
        await redeliver(producer, pausedJob);
        assert.equal(submissions.length, priorSubmissions, 'an attempted job cannot submit again while paused');
        assert.equal((await json(host, '/api/operator?test-policy-revision=4')).paused, false);
        await redeliver(producer, resumedJob);
        assert.equal(submissions.length, priorSubmissions, 'pause and resume between attempts permanently invalidate the job');
        const canceledAttempts = new Set([pausedJob.deliveryId, resumedJob.deliveryId]);
        await until(() => actions.filter(action => canceledAttempts.has(action.id) && action.ack).length === 4, 7000);
        assert.equal(errors.length, priorErrors, 'canceled jobs do not record transport failures');

        healthy = true;
        providerStatus = 204;
        await json(host, monitorPath, 'PATCH', { destinationIds: [destination.id] });
        await tick(host);
        await until(() => submissions.length === priorSubmissions + 1 && completedBatches === batches.length);

        healthy = false;
        let releaseProvider;
        holdProvider = new Promise(resolve => { releaseProvider = resolve; });
        try {
          const beforeDeadline = completedBatches;
          await tick(host);
          await until(() => submissions.length === priorSubmissions + 2);
          // The simulated provider stays unanswered while the real delivery deadline runs.
          await until(() => completedBatches > beforeDeadline, 13_000);
          assert.ok(performance.now() - providerStartedAt >= 9500, 'the held provider reaches the configured deadline');
          const [retrying] = (await json(host, path)).destinations;
          assert.deepEqual(retrying.latestSubmission, {
            status: 'retrying', reason: 'network', at: retrying.latestSubmission.at,
          });
          assert.deepEqual(actions.at(-1).retry, { delaySeconds: 5 });
          await json(host, monitorPath, 'PATCH', { destinationIds: [] });
          await json(host, monitorPath, 'PATCH', { destinationIds: [destination.id] });
          const pending = completedBatches;
          await until(() => completedBatches > pending, 7000);
          assert.deepEqual(actions.at(-1), { id: actions.at(-2).id, ack: true });
          assert.equal(submissions.length, priorSubmissions + 2, 're-selection cancels a pending retry');
          assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'canceled');
        } finally {
          releaseProvider();
          holdProvider = undefined;
        }
      }
    }
    await deletePersonalMonitor();

    const tenant = 'tenant.example';
    const peer = 'peer.example';
    const target = 'https://internal.example:8443/target-secret';
    const tenantWebhook = 'https://hooks.example/paused-secret';
    const peerWebhook = 'https://hooks.example/peer-secret';
    const reader = { authorization: 'Bearer reader' };
    const spoofedResume = { 'x-paused': 'false', 'x-policy-revision': '10000', 'x-context-id': peer };
    assert.equal((await json(tenant, '/api/status?test-policy-revision=5')).paused, true);
    const beforeConfig = (await json(tenant, '/api/operator')).incidents;
    const created = await json(tenant, monitors, 'POST', { name: 'Created while paused', url: target, failureThreshold: 1 }, 201);
    const newMonitor = created.monitors.find(monitor => monitor.name === 'Created while paused');
    assert.equal(newMonitor.state, 'paused');
    assert.deepEqual(newMonitor.destinationIds, []);
    const configured = await json(tenant, path, 'POST', { url: tenantWebhook }, 201);
    const tenantDestination = configured.destinations.find(destination => destination.url === tenantWebhook);
    const newMonitorPath = monitors + '/' + newMonitor.id;
    const edited = await json(tenant, newMonitorPath, 'PATCH', { name: 'Edited while paused', destinationIds: [tenantDestination.id] }, 200, spoofedResume);
    assert.equal(edited.paused, true);
    assert.deepEqual(edited.monitors.find(monitor => monitor.id === newMonitor.id).destinationIds, [tenantDestination.id]);
    assert.equal((await json(tenant, '/api/operator', 'PUT', { pageName: 'Paused tenant' })).pageName, 'Paused tenant');
    for (const [endpoint, method, value] of [[path, 'POST', { url: peerWebhook }], [newMonitorPath, 'PATCH', { destinationIds: [] }]]) {
      assert.equal((await request(tenant, endpoint, method, value, reader)).status, 403);
    }
    const read = await json(tenant, '/api/operator', 'GET', undefined, 200, reader);
    const publicStatus = await json(tenant, '/api/status', 'GET', undefined, 200, { authorization: '' });
    for (const projection of [read, publicStatus]) {
      assert.equal(projection.paused, true);
      assert.equal(projection.pageName, 'Paused tenant');
      assert.equal(projection.monitors.find(monitor => monitor.id === newMonitor.id).state, 'paused');
      assert.doesNotMatch(JSON.stringify(projection), /destinations|destinationIds|hooks\.example/);
    }
    assert.doesNotMatch(JSON.stringify(publicStatus), /internal\.example|target-secret/);
    assert.equal(publicStatus.monitors.length, 1, 'the paused private Monitor stays private');

    const peerMonitor = await json(peer, monitors, 'POST', { name: 'Peer', url: target, failureThreshold: 1 }, 201);
    const peerConfig = await json(peer, path, 'POST', { url: peerWebhook }, 201);
    await json(peer, monitors + '/' + peerMonitor.monitor.id, 'PATCH', { destinationIds: [peerConfig.destinations[0].id] });
    const beforePausedTick = { batches: batches.length, submissions: submissions.length, checks: targetRequests };
    await tick(tenant);
    assert.equal(targetRequests, beforePausedTick.checks, 'persisted pause suppresses scheduled checks even when discovery omits policy');
    const paused = await json(tenant, '/api/operator');
    assert.equal(paused.monitors.find(monitor => monitor.id === newMonitor.id).lastResult, null);
    assert.deepEqual(paused.incidents, beforeConfig);

    await tick(peer);
    await until(() => completedBatches > beforePausedTick.batches);
    assert.deepEqual(submissions.slice(beforePausedTick.submissions).map(item => item.url), [peerWebhook]);
    assert.deepEqual(batches.slice(beforePausedTick.batches).flat().map(job => job.event.monitorName), ['Peer']);
    assert.equal((await json(peer, '/api/status')).paused, false);
    assert.equal((await json(tenant, '/api/status')).paused, true);

    assert.equal((await json(tenant, '/api/operator?test-policy-revision=6')).paused, false);
    const firstCheckAt = at;
    await tick(tenant);
    await until(() => submissions.length === beforePausedTick.submissions + 2 && completedBatches === batches.length);
    assert.equal(submissions.at(-1).url, tenantWebhook);
    assert.match(submissions.at(-1).payload.text, /Edited while paused/);
    assert.ok(submissions.at(-1).payload.text.includes(new Date(firstCheckAt).toISOString()), 'resume sends only the fresh Incident');
    {

      const host = 'retry.example';
      providerStatus = 204;
      healthy = false;
      const retryMonitor = await json(host, monitors, 'POST', { name: 'Retry Monitor', url: target, failureThreshold: 1 }, 201);
      const monitorPath = monitors + '/' + retryMonitor.monitor.id;
      await json(host, path, 'POST', { url: 'https://hooks.example/retry-one' }, 201);
      const { destinations: [first, second] } = await json(host, path, 'POST', { url: 'https://hooks.example/retry-two' }, 201);
      await json(host, monitorPath, 'PATCH', { destinationIds: [first.id, second.id] });
      const baseline = completedBatches;
      await tick(host);
      await until(() => completedBatches > baseline);
      const origins = batches.at(-1);
      const [firstOrigin, secondOrigin] = [first, second].map(destination =>
        origins.find(job => job.destinationId === destination.id));
      const job = (origin, name, offset = 0) => ({
        ...origin, deliveryId: name + ':' + origin.destinationId,
        event: { ...origin.event, id: name, at: origin.event.at + offset },
      });
      async function sendBatch(jobs, overrides = []) {
        const before = actions.length;
        overrides.forEach((override, i) => controls.set(jobs[i].deliveryId, override));
        await producer.sendBatch(jobs.map(body => ({ body })));
        await until(() => actions.length >= before + jobs.length);
        return actions.slice(before);
      }
      const retryJob = job(firstOrigin, 'retry', 1000);
      const successfulJob = job(secondOrigin, 'success', 1000);
      providerStatuses.set(first.url, 429);
      providerStatuses.set(second.url, 204);
      const independent = await sendBatch([retryJob, successfulJob], [{ attempts: 1 }]);
      assert.deepEqual(independent.find(action => action.id === successfulJob.deliveryId), { id: successfulJob.deliveryId, ack: true });
      assert.deepEqual(independent.find(action => action.id === retryJob.deliveryId).retry, { delaySeconds: 5 });
      assert.deepEqual((await json(host, path)).destinations.map(destination => destination.latestSubmission.status), ['retrying', 'accepted']);
      for (const [index, delaySeconds] of [10, 20, 40, 80, 160, 320, 640, 1280].entries()) {
        const [attempt] = await sendBatch([retryJob], [{ attempts: index + 2 }]);
        assert.deepEqual(attempt.retry, { delaySeconds });
      }
      const beforeExhaustion = submissions.length;
      assert.deepEqual(await sendBatch([retryJob], [{ attempts: 10 }]), [{ id: retryJob.deliveryId, ack: true }]);
      assert.equal(submissions.length, beforeExhaustion + 1, 'attempt ten may submit');
      await until(() => deadLetters.length === 1);
      assert.equal(deadLetters[0].reason, 'attempts_exhausted');
      assert.equal(deadLetters[0].attempts, 10);
      const tooLate = job(firstOrigin, 'expired', 2000);
      const overLimit = job(firstOrigin, 'over-limit', 1500);
      assert.ok((await sendBatch([tooLate], [{ timestamp: Date.now() - 3_600_000 }]))[0].ack);
      assert.ok((await sendBatch([overLimit], [{ attempts: 11 }]))[0].ack);
      assert.equal(submissions.length, beforeExhaustion + 1, 'expired jobs and attempt eleven never call the provider');
      await until(() => deadLetters.length === 3);
      assert.deepEqual(deadLetters.map(letter => letter.reason), ['attempts_exhausted', 'expired', 'attempts_exhausted']);
      assert.deepEqual(Object.keys(deadLetters[0]).sort(), ['attempts', 'contextId', 'deliveryId', 'destinationId', 'queuedAt', 'reason']);
      assert.doesNotMatch(JSON.stringify(deadLetters), /token|target-secret|sensitive provider response|Website/);
      assert.match(JSON.stringify((await json(host, path)).destinations[0].latestSubmission), /"status":"failed","reason":"expired"/);

      const permanent = job(firstOrigin, 'permanent', 3000);
      providerStatuses.set(first.url, 403);
      assert.ok((await sendBatch([permanent]))[0].ack);
      assert.match(JSON.stringify((await json(host, path)).destinations[0].latestSubmission), /"status":"failed","reason":"provider_rejected"/);
      assert.equal(deadLetters.length, 3, 'permanent failures stop on their first attempt');
      assert.doesNotMatch(errors.join('\n'), /token|target-secret|sensitive provider response|Website/);

      const older = job(firstOrigin, 'older', 4000);
      const newer = job(firstOrigin, 'newer', 5000);
      providerStatuses.set(first.url, 204);
      let releaseSlow;
      holdProvider = new Promise(resolve => { releaseSlow = resolve; });
      heldEventTime = new Date(older.event.at).toISOString();
      const prior = submissions.length;
      let pendingOlder;
      try {
        pendingOlder = sendBatch([older, newer]);
        await until(() => submissions.length === prior + 2);
        const deadline = Date.now() + 5000;
        while ((await json(host, path)).destinations[0].latestSubmission.status !== 'accepted') {
          assert.ok(Date.now() < deadline, 'a newer result can complete while the older provider request is held');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } finally {
        releaseSlow();
      }
      await pendingOlder;
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted');

      const beforePending = submissions.length;
      const pendingJob = job(firstOrigin, 'queued-before-restart', 6000);
      await producer.send(pendingJob, { delaySeconds: 1 });
      assert.equal((await request(host, '/test-restart?context=' + pendingJob.contextId)).status, 204);
      const queuedAction = () => actions.find(action => action.id === pendingJob.deliveryId);
      assert.equal(queuedAction(), undefined, 'the job is still queued when the MonitoringContext restarts');
      await until(() => queuedAction());
      assert.equal(queuedAction().ack, true);
      assert.equal(submissions.length, beforePending + 1, 'the queued job submits after the MonitoringContext restarts');

      holdProvider = heldEventTime = undefined;
      const reported = job(firstOrigin, 'accepted-report-outage', 7000);
      reportFaults.set(reported.deliveryId, 1);
      providerStatuses.set(first.url, 403);
      await sendBatch([job(firstOrigin, 'before-accepted-report-outage', 6500)]);
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'failed');
      providerStatuses.set(first.url, 204);
      const beforeAccepted = submissions.length;
      await sendBatch([reported]);
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'failed');
      await sendBatch([reported]);
      assert.equal(submissions.length, beforeAccepted + 1, 'a duplicate cannot resubmit a known acceptance during a result RPC outage');
      await until(async () => (await json(host, path)).destinations[0].latestSubmission.status === 'accepted', 9000);
      assert.equal(reportAttempts.filter(id => id === reported.deliveryId).length, 2);

      for (const outage of [false, true]) {
        const stale = job(firstOrigin, 'older-attempt-' + outage, 8000 + 500 * Number(outage));
        const newerRetry = job(firstOrigin, 'newer-retry-event-' + outage, 8100 + 500 * Number(outage));
        const beforeErrors = errors.length;
        if (outage) reportFaults.set(stale.deliveryId, 1);
        const beforeRace = submissions.length;
        let releaseOldFailure;
        holdProvider = new Promise(resolve => { releaseOldFailure = resolve; });
        heldEventTime = 'Held old attempt';
        // Pause only the older copy of this delivery while the newer attempt returns 429.
        providerStatuses.set(first.url, 429);
        let racingAttempts;
        try {
          controls.set(stale.deliveryId, [{ attempts: 1 }, { attempts: 2 }]);
          racingAttempts = sendBatch([{ ...stale, event: { ...stale.event, monitorName: heldEventTime } }, stale]);
          await until(() => submissions.length === beforeRace + 2);
          if (outage) {
            await until(() => errors.slice(beforeErrors).some(error => error.includes('notification_submission_report_failed')));
          } else {
            await until(async () => (await json(host, path)).destinations[0].latestSubmission.status === 'retrying');
          }
        } finally {
          releaseOldFailure();
          holdProvider = heldEventTime = undefined;
        }
        const raceActions = await racingAttempts;
        assert.ok(raceActions.some(action => action.retry?.delaySeconds === 10), 'attempt two requests its retry');
        const afterRace = (await json(host, path)).destinations[0].latestSubmission;
        if (outage) {
          assert.notEqual(afterRace.reason, 'provider_rejected', 'a failed retry report cannot let the older 403 close the delivery');
          await until(() => reportAttempts.filter(id => id === stale.deliveryId).length === 2, 9000);
          assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'retrying');
        } else {
          assert.equal(afterRace.status, 'retrying', 'the late 403 cannot replace the newer retry');
        }
        await sendBatch([newerRetry], [{ attempts: 1 }]);
        providerStatuses.set(first.url, 204);
        await sendBatch([stale], [{ attempts: 3 }]);
        assert.equal(submissions.length, beforeRace + 4, 'the late 403 cannot close a newer retry');
      }

      const olderAccepted = job(firstOrigin, 'older-provider-acceptance', 8750);
      const beforeOlderAcceptance = submissions.length;
      let releaseAcceptance;
      holdProvider = new Promise(resolve => { releaseAcceptance = resolve; });
      heldEventTime = 'Held acceptance';
      heldProviderStatus = 204;
      providerStatuses.set(first.url, 429);
      try {
        const olderCopy = { ...olderAccepted, event: { ...olderAccepted.event, monitorName: heldEventTime } };
        controls.set(olderAccepted.deliveryId, [{ attempts: 1 }, { attempts: 2 }]);
        const pending = sendBatch([olderCopy, olderAccepted]);
        try {
          await until(() => submissions.length === beforeOlderAcceptance + 2);
          await until(async () => (await json(host, path)).destinations[0].latestSubmission.status === 'retrying');
        } finally {
          releaseAcceptance();
        }
        await pending;
      } finally {
        holdProvider = heldEventTime = undefined;
        heldProviderStatus = 403;
      }
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted');
      assert.ok((await sendBatch([olderAccepted], [{ attempts: 3 }]))[0].ack);
      assert.equal(submissions.length, beforeOlderAcceptance + 2, 'an older accepted request closes newer retries');

      for (const [status, attempts, reason] of [[403, 1, 'provider_rejected'], [429, 11, 'attempts_exhausted']]) {
        const terminal = job(firstOrigin, 'terminal-report-outage-' + status, 8800 + status);
        const beforeTerminal = submissions.length;
        const beforeReports = reportAttempts.length;
        reportFaults.set(terminal.deliveryId, 1);
        providerStatuses.set(first.url, status);
        assert.deepEqual(await sendBatch([terminal], [{ attempts }]), [{ id: terminal.deliveryId, ack: true }]);
        assert.equal(reportAttempts[beforeReports], terminal.deliveryId);
        assert.notEqual((await json(host, path)).destinations[0].latestSubmission.reason, reason);
        assert.deepEqual(await sendBatch([terminal], [{ attempts: 1 }]), [{ id: terminal.deliveryId, ack: true }]);
        assert.equal(submissions.length, beforeTerminal + Number(attempts === 1), 'terminal failures close submission during a result RPC outage');
        await until(async () => (await json(host, path)).destinations[0].latestSubmission.reason === reason, 9000);
      }

      const accepted = job(firstOrigin, 'acceptance-pending', 9800);
      const beforePendingAcceptance = submissions.length;
      providerStatuses.set(first.url, 204);
      reportFaults.set(accepted.deliveryId, 1);
      assert.ok((await sendBatch([accepted], [{ attempts: 1 }]))[0].ack);
      assert.equal(reportAttempts.filter(id => id === accepted.deliveryId).length, 1);
      assert.ok((await sendBatch([accepted], [{ attempts: 1 }]))[0].ack);
      assert.equal(reportAttempts.filter(id => id === accepted.deliveryId).length, 1, 'Settings is still waiting for recovery');
      assert.equal(submissions.length, beforePendingAcceptance + 1, 'a known acceptance closes duplicate submission before Settings recovers');
      await until(async () => (await json(host, path)).destinations[0].latestSubmission.status === 'accepted', 9000);

      const finalProducer = await mf.getQueueProducer('FINAL_QUEUE', 'monitoring');
      const final = job(firstOrigin, 'final-dlq-outage', 10_000);
      const beforeFinal = submissions.length;
      const beforeLetters = deadLetters.length;
      const beforeFinalBatch = completedBatches;
      const beforeFinalResult = (await json(host, path)).destinations[0].latestSubmission;
      controls.set(final.deliveryId, { attempts: 11 });
      dlqFaults.add(final.deliveryId);
      reportFaults.set(final.deliveryId, 1);
      await finalProducer.send(final);
      await until(() => completedBatches > beforeFinalBatch);
      assert.equal(submissions.length, beforeFinal, 'the final delivery cannot submit again');
      assert.ok(dlqAttempts.includes(final.deliveryId), 'the final delivery exercised the failing DLQ producer');
      assert.ok(reportAttempts.includes(final.deliveryId), 'the result RPC ran independently of the failing DLQ producer');
      assert.deepEqual(actions.at(-1), { id: final.deliveryId, ack: true }, 'only diagnostic recovery remains after final delivery');
      await until(async () => {
        const result = (await json(host, path)).destinations[0].latestSubmission;
        return result.reason === 'attempts_exhausted' && result.at !== beforeFinalResult.at;
      }, 9000);
      assert.equal(reportAttempts.filter(id => id === final.deliveryId).length, 2);
      assert.equal(deadLetters.length, beforeLetters, 'terminal feedback recovers while the DLQ is still unavailable');
      dlqFaults.delete(final.deliveryId);
      await until(() => deadLetters.length > beforeLetters, 20_000);
      assert.deepEqual(Object.keys(deadLetters.at(-1)).sort(), ['attempts', 'contextId', 'deliveryId', 'destinationId', 'queuedAt', 'reason']);
      assert.equal(deadLetters.at(-1).deliveryId, final.deliveryId);
      assert.equal(deadLetters.at(-1).attempts, 0, 'an exhausted broker does not spend a provider attempt');
      assert.doesNotMatch(JSON.stringify(deadLetters.at(-1)) + errors.join('\n'), /Retry Monitor|target-secret|sensitive provider response|https:\/\//);

      const unavailable = job(firstOrigin, 'final-persistence-outage', 11_000);
      const beforeFallback = completedBatches;
      const beforeFallbackResult = (await json(host, path)).destinations[0].latestSubmission;
      const originalBrokerTime = Date.now() - 60_000;
      controls.set(unavailable.deliveryId, { attempts: 11, timestamp: originalBrokerTime });
      recoveryFaults.set(unavailable.deliveryId, 3);
      reportFaults.set(unavailable.deliveryId, 1);
      await finalProducer.send(unavailable);
      await until(() => completedBatches > beforeFallback);
      assert.ok(actions.some(action => action.id === unavailable.deliveryId && action.ack),
        'the broker’s final delivery hands off the outcome before acknowledging the source');
      await until(() => deadLetters.some(letter => letter.deliveryId === unavailable.deliveryId), 25_000);
      const diagnostic = deadLetters.find(letter => letter.deliveryId === unavailable.deliveryId);
      assert.deepEqual(Object.keys(diagnostic).sort(), ['attempts', 'contextId', 'deliveryId', 'destinationId', 'queuedAt', 'reason']);
      assert.equal(diagnostic.attempts, 0);
      assert.equal(diagnostic.queuedAt, originalBrokerTime);
      const handoff = batches.flat().find(job => job.deliveryId === unavailable.deliveryId && job.terminal);
      assert.ok(handoff, 'terminal bookkeeping has its own broker delivery');
      assert.deepEqual(handoff.event, { at: unavailable.event.at, order: unavailable.event.order });
      assert.doesNotMatch(JSON.stringify(handoff), /Retry Monitor|target-secret|https:\/\//);
      assert.equal(recoveryCalls.filter(id => id === unavailable.deliveryId).length, 4, 'the last broker delivery survives three Recovery RPC failures');
      assert.equal(diagnostic.reason, 'attempts_exhausted');
      await until(async () => {
        const result = (await json(host, path)).destinations[0].latestSubmission;
        return result.reason === 'attempts_exhausted' && result.at !== beforeFallbackResult.at;
      }, 15_000);
      assert.equal(reportAttempts.filter(id => id === unavailable.deliveryId).length, 2);
      assert.equal(submissions.length, beforeFinal, 'bookkeeping retries cannot call the provider');
      assert.doesNotMatch(JSON.stringify(diagnostic) + errors.join('\n'), /Retry Monitor|target-secret|sensitive provider response|https:\/\//);

      const copies = job(firstOrigin, 'same-broker-ordinal', 10_500);
      const beforeCopies = submissions.length;
      providerStatuses.set(first.url, 429);
      for (let i = 0; i < 11; i++) {
        const [action] = await sendBatch([copies], [{ attempts: 1 }]);
        if (i < 9) assert.equal(action.retry?.delaySeconds, 5 * 2 ** i);
        else assert.equal(action.ack, true);
      }
      assert.equal(submissions.length, beforeCopies + 10, 'same-ordinal copies share a ten-submission budget');
      await until(() => deadLetters.some(letter => letter.deliveryId === copies.deliveryId && letter.attempts === 10));

      const unavailableGate = job(firstOrigin, 'eligibility-does-not-spend-a-submission', 10_600);
      resolveFaults.set(unavailableGate.deliveryId, 8);
      const beforeUnavailableGate = submissions.length;
      for (let i = 1; i <= 8; i++) {
        const [action] = await sendBatch([unavailableGate], [{ attempts: i }]);
        assert.equal(action.retry?.delaySeconds, 5 * 2 ** (i - 1));
      }
      assert.equal(submissions.length, beforeUnavailableGate);
      const [firstSubmission] = await sendBatch([unavailableGate], [{ attempts: 9 }]);
      assert.equal(firstSubmission.retry?.delaySeconds, 5, 'the provider budget starts with the first actual submission');
      assert.equal(submissions.length, beforeUnavailableGate + 1);

      const beforeRestart = submissions.length;
      options.workers[0].script += '\n// Restart monitoring after acceptance';
      options.workers[1].script += '\n// Restart delivery after acceptance';
      await mf.setOptions(convertV4MiniflareOptions(options));
      producer = await mf.getQueueProducer('NOTIFICATION_QUEUE', 'monitoring');
      const beforeReplay = actions.length;
      await producer.sendBatch([older, newer, successfulJob, accepted, copies, olderAccepted].map(body => ({ body })));
      await until(() => actions.length === beforeReplay + 6);
      assert.ok(actions.slice(beforeReplay).every(action => action.ack));
      assert.equal(submissions.length, beforeRestart, 'completed identities survive restart, including out-of-order completion');
      assert.equal((await json(host, path)).destinations[0].latestSubmission.reason, 'attempts_exhausted');
      const aging = job(secondOrigin, 'expires-at-final-gate', 12_000);
      const beforeAging = submissions.length;
      const closeToExpiry = Date.now() - 3_600_000 + 1000;
      let releaseAging;
      let agingEntered;
      const enteredAging = new Promise(resolve => { agingEntered = resolve; });
      resolutionGates.set(aging.deliveryId, { enter: agingEntered, release: new Promise(resolve => { releaseAging = resolve; }) });
      const agingDelivery = sendBatch([aging], [{ timestamp: closeToExpiry }]);
      await enteredAging;
      try {
        await until(() => Date.now() >= closeToExpiry + 3_600_000);
      } finally {
        releaseAging();
        resolutionGates.delete(aging.deliveryId);
      }
      assert.ok((await agingDelivery)[0].ack);
      assert.equal(submissions.length, beforeAging, 'eligibility resolution cannot let a job cross the deadline before submitting');
      await until(() => deadLetters.some(letter => letter.deliveryId === aging.deliveryId && letter.reason === 'expired'));

      const revoked = job(firstOrigin, 'revoked-at-final-gate', 12_000);
      const beforeRevoked = submissions.length;
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      resolutionGates.set(revoked.deliveryId, { enter, release: new Promise(resolve => { release = resolve; }) });
      const waiting = sendBatch([revoked]);
      await entered;
      try {
        await json(host, monitorPath, 'PATCH', { destinationIds: [second.id] });
        await json(host, monitorPath, 'PATCH', { destinationIds: [first.id, second.id] });
      } finally {
        release();
        resolutionGates.delete(revoked.deliveryId);
      }
      assert.ok((await waiting)[0].ack);
      assert.equal(submissions.length, beforeRevoked, 'the final eligibility read sees deselection and re-selection');

      console.log('PASS real Queue delivery: independent ack/retry, deadline and limits, cancellation, submission ordering, durable result recovery and safe DLQ recovery');
    }
    for (const status of [429, 204]) {
      const host = 'cancellation-' + status + '.example';
      const url = 'https://hooks.example/cancellation-' + status;
      const { monitor } = await json(host, monitors, 'POST', { name: 'Maintenance Monitor', url: target }, 201);
      const { destinations: [destination] } = await json(host, path, 'POST', { url }, 201);
      const monitorPath = monitors + '/' + monitor.id;
      const select = destinationIds => json(host, monitorPath, 'PATCH', { destinationIds });
      const latest = async () => (await json(host, path)).destinations[0].latestSubmission;
      await select([destination.id]);
      providerStatuses.set(url, status);
      const before = submissions.length;
      const priorBatches = batches.length;
      const priorActions = actions.length;
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let job;
      try {
        if (status === 204) {
          holdProvider = held;
          heldEventTime = monitor.name;
          heldProviderStatus = status;
        }
        let admit;
        holdBatch = new Promise(resolve => { admit = resolve; });
        try {
          await json(host, monitorPath + '/maintenance', 'PUT', { endsAt: Date.now() + 60_000 });
          await until(() => batches.length > priorBatches);
          [job] = batches.at(-1);
          if (status === 429) retryReportGates.set(job.deliveryId, held);
        } finally {
          admit();
          holdBatch = undefined;
        }
        await until(() => status === 429 ? reportAttempts.includes(job.deliveryId) : submissions.length > before);
        await select([]);
        // The source Queue waits for its held batch. Use the other fixture Queue for the concurrent copy.
        await redeliver(await mf.getQueueProducer('FINAL_QUEUE', 'monitoring'), job);
        assert.equal(reportAttempts.filter(id => id === job.deliveryId).length, status === 429 ? 2 : 1);
        assert.deepEqual(actions.slice(priorActions), [{ id: job.deliveryId, ack: true }]);
        assert.equal(await latest(), undefined, 'cancellation before any reported result stays hidden');
        await select([destination.id]);
      } finally {
        release();
        holdProvider = heldEventTime = undefined;
        if (job) retryReportGates.delete(job.deliveryId);
      }
      await until(() => actions.length === priorActions + 2);
      heldProviderStatus = 403;
      assert.deepEqual(actions.at(-1), { id: job.deliveryId, ack: true });
      assert.equal((await latest())?.status, status === 204 ? 'accepted' : undefined,
        'a late retry stays hidden while an already-submitted acceptance is preserved');
      await redeliver(producer, job);
      assert.equal(submissions.length, before + 1, 're-selection cannot revive the canceled job');
    }
    console.log('PASS real Queue cancellation: delayed retry suppressed and already-submitted acceptance preserved');

    {
      const host = 'concurrent-exhaustion.example';
      const url = 'https://hooks.example/concurrent-exhaustion';
      const { monitor } = await json(host, monitors, 'POST', {
        name: 'Concurrent Monitor', url: target, failureThreshold: 1,
      }, 201);
      const { destinations: [destination] } = await json(host, path, 'POST', { url }, 201);
      await json(host, monitors + '/' + monitor.id, 'PATCH', { destinationIds: [destination.id] });
      const beforeIncident = completedBatches;
      healthy = false;
      await tick(host);
      await until(() => completedBatches > beforeIncident);
      const [origin] = batches.at(-1);

      for (const status of [204, 429]) {
        const job = { ...origin, deliveryId: 'concurrent-' + status, event: { ...origin.event, at: origin.event.at + status } };
        const beforeAttempts = submissions.length;
        const beforeBatch = completedBatches;
        let release;
        holdProvider = new Promise(resolve => { release = resolve; });
        heldEventTime = 'First pending attempt';
        heldProviderStatus = status;
        providerStatuses.set(url, 429);
        const held = { ...job, event: { ...job.event, monitorName: heldEventTime } };
        try {
          await producer.send(held);
          await until(() => submissions.length === beforeAttempts + 1);
          controls.set(job.deliveryId, Array.from({ length: 9 }, () => ({ attempts: 1 })));
          await producer.sendBatch(Array.from({ length: 9 }, () => ({ body: job })));
          await until(() => submissions.length === beforeAttempts + 10);
          // Allow the last temporary response to reach Recovery while the first request is held.
          await new Promise(resolve => setTimeout(resolve, 300));
          assert.notEqual((await json(host, path)).destinations[0].latestSubmission.reason, 'attempts_exhausted');
          assert.ok(!dlqAttempts.includes(job.deliveryId), 'exhaustion cannot be published while a provider can still accept');
        } finally {
          release();
          holdProvider = heldEventTime = undefined;
        }
        await until(() => completedBatches >= beforeBatch + 2);
        heldProviderStatus = 403;
        if (status === 204) {
          assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted');
          assert.ok(!dlqAttempts.includes(job.deliveryId), 'a known acceptance prevents exhaustion');
        } else {
          await until(() => deadLetters.some(letter => letter.deliveryId === job.deliveryId));
          assert.equal((await json(host, path)).destinations[0].latestSubmission.reason, 'attempts_exhausted');
          assert.equal(deadLetters.filter(letter => letter.deliveryId === job.deliveryId).length, 1);
        }
        assert.equal(submissions.length, beforeAttempts + 10);
      }
      console.log('PASS concurrent exhaustion: ten same-ordinal submissions, held acceptance wins, all-temporary submissions dead-letter once');
    }

    {
      const host = 'causal-order.example';
      const url = 'https://hooks.example/causal-order';
      const { monitor } = await json(host, monitors, 'POST', {
        name: 'Causal Monitor', url: target,
      }, 201);
      const { destinations: [destination] } = await json(host, path, 'POST', { url }, 201);
      const monitorPath = monitors + '/' + monitor.id;
      await json(host, monitorPath, 'PATCH', { destinationIds: [destination.id] });
      const maintenance = monitorPath + '/maintenance';
      const eventAt = Date.now();
      async function commitMaintenance(endsAt, uuid, reportOutage = false) {
        assert.equal((await request(host, '/test-clock?at=' + eventAt + '&uuid=' + uuid)).status, 204);
        const before = completedBatches;
        let release;
        holdBatch = new Promise(resolve => { release = resolve; });
        try {
          await json(host, maintenance, 'PUT', { endsAt });
          const [created] = await until(() => batches.length > before && batches.at(-1));
          assert.equal(created.event.at, eventAt);
          controls.set(created.deliveryId, { timestamp: eventAt });
          if (reportOutage) reportFaults.set(created.deliveryId, 1);
          return created;
        } finally {
          release();
          holdBatch = undefined;
          await until(() => completedBatches > before);
        }
      }
      providerStatuses.set(url, 403);
      const older = await commitMaintenance(eventAt + 60_000, 'ffffffff-0000-4000-8000-000000000000');
      assert.equal((await json(host, path)).destinations[0].latestSubmission.reason, 'provider_rejected');

      providerStatuses.set(url, 204);
      const newer = await commitMaintenance(eventAt + 120_000, '00000000-0000-4000-8000-000000000000', true);
      assert.ok(newer.deliveryId < older.deliveryId, 'the legacy UUID tie-break would favor the older job');
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'failed', 'the first report RPC failed');
      await until(async () => (await json(host, path)).destinations[0].latestSubmission.status === 'accepted', 9000);
      assert.equal(reportAttempts.filter(id => id === newer.deliveryId).length, 2);

      const { order: _order, ...legacyEvent } = older.event;
      const legacy = { ...older, deliveryId: 'legacy-' + older.deliveryId, event: legacyEvent };
      providerStatuses.set(url, 403);
      await redeliver(producer, legacy);
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted',
        'an unordered legacy job cannot replace an ordered result at the same event time');

      assert.equal(newer.event.at, older.event.at);
      assert.equal((await request(host, '/test-clock?at=0')).status, 204);
      console.log('PASS committed Maintenance ordering: equal event and broker times, report recovery and a legacy Queue copy');
    }

    console.log('PASS real Queue delivery: opt-in, fan-out, safe content, redirects, deadline, tenant isolation, paused configuration, and cancellation before and between attempts');

    {
      const inbox = 'ops+test@example.net';
      const email = address => ({ channel: 'email', address });
      const setClock = (host, at) => request(host, '/test-clock?at=' + at);
      assert.equal((await request('no-email.example', path, 'POST', email(inbox))).status, 503);
      const withoutEmail = await json('no-email.example', path, 'POST', { url: 'https://hooks.example/ordinary' }, 201);
      assert.ok(!('emailConfigured' in withoutEmail));
      assert.equal(withoutEmail.destinations.length, 1);
      const denied = await mf.dispatchFetch('https://tenant.example' + path, {
        method: 'POST', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
        body: JSON.stringify(email(inbox)),
      });
      assert.equal(denied.status, 403);
      const added = await json('personal.example', path, 'POST', email(inbox), 201);
      assert.equal(added.emailConfigured, true);
      const pending = added.destinations.find(destination => destination.channel === 'email');
      assert.equal(pending.name, 'Email 1');
      assert.equal(pending.confirmed, false);
      const renamed = await json('personal.example', path + '/' + pending.id, 'PUT', { ...email(inbox), name: 'Operations inbox' });
      assert.equal(renamed.destinations.find(destination => destination.id === pending.id).name, 'Operations inbox');
      const { monitor } = await json('personal.example', monitors, 'POST', { name: 'Email opt-in', kind: 'heartbeat' }, 201);
      const monitorPath = monitors + '/' + monitor.id;
      assert.equal((await request('personal.example', monitorPath, 'PATCH', { destinationIds: [pending.id] })).status, 400);
      assert.equal((await request('personal.example', monitorPath, 'PATCH', { destinationChanges: { [pending.id]: true } })).status, 400);
      const message = await until(async () => (await capturedMail())[0]);
      const link = await confirmationLink(message, inbox);
      assert.equal(link.origin, 'https://personal.example');
      const token = link.hash.slice(1);
      assert.ok(!/ops\+test|personal\.example/.test(JSON.stringify(batches.at(-1))), 'Queue payload excludes recipient metadata');
      assert.ok(!JSON.stringify(batches.at(-1)).includes(token), 'Queue payload excludes the confirmation fragment');
      assert.ok(!JSON.stringify(added).includes(token), 'operator snapshot excludes the confirmation fragment');
      const recipient = (origin = link.origin, method = 'GET', credential = token) => mf.dispatchFetch(new URL(link.pathname, origin), {
        method,
        ...(method === 'POST' ? { body: new URLSearchParams({ token: credential }) } : {}),
      });
      assert.equal((await recipient()).status, 200);
      assert.equal((await json('personal.example', path)).destinations.find(destination => destination.id === pending.id).confirmed, false);
      assert.equal((await recipient('https://tenant.example', 'POST')).status, 400);
      assert.equal((await recipient(link.origin, 'POST')).status, 200);
      assert.equal((await recipient(link.origin, 'POST')).status, 400);
      assert.equal((await json('personal.example', path)).destinations.find(destination => destination.id === pending.id).confirmed, true);
      assert.equal((await capturedMail()).length, 1);
      assert.deepEqual((await json('personal.example', '/api/operator')).monitor.destinationIds, []);
      await json('personal.example', monitorPath, 'PATCH', { destinationIds: [pending.id] });
      const replacement = await json('personal.example', path + '/' + pending.id, 'PUT', email('replacement@example.net'));
      assert.deepEqual(replacement.monitor.destinationIds, []);
      const newInbox = replacement.destinations.find(destination => destination.address === 'replacement@example.net');
      assert.equal(newInbox.confirmed, false);
      assert.equal(newInbox.name, 'Operations inbox');
      await until(async () => completedBatches === batches.length && (await capturedMail()).length === 2);

      const consentHost = 'consent-tenant.example';
      const consentOrigin = 'https://' + consentHost;
      const addTenant = async (address, search = '') => (await json(consentHost, path + search, 'POST', email(address), 201))
        .destinations.find(destination => destination.address === address);
      const consentDestination = await addTenant(inbox);
      const consentPath = path + '/' + consentDestination.id;
      const resend = () => request(consentHost, consentPath + '/confirmation', 'POST');
      await until(async () => (await capturedMail()).length === 3 && completedBatches === batches.length);
      const tenantJob = batches.at(-1)[0];
      const latestToken = async address => {
        const link = await confirmationLink((await capturedMail())[0], address);
        assert.equal(link.origin, consentOrigin);
        return link.hash.slice(1);
      };
      const previous = await latestToken(inbox);
      const readerResponse = await mf.dispatchFetch('https://' + consentHost + '/api/operator', { headers: { authorization: 'Bearer reader' } });
      const readerSnapshot = await readerResponse.text();
      const publicSnapshot = await (await request(consentHost, '/api/status')).text();
      assert.ok(!/example\.net|emailConfigured/.test(readerSnapshot) && !readerSnapshot.includes(previous),
        'reader snapshot excludes email configuration, addresses and confirmation fragments');
      assert.ok(!publicSnapshot.includes('@example.net') && !publicSnapshot.includes(previous),
        'public snapshot excludes email addresses and confirmation fragments');
      await setClock(consentHost, tenantJob.at + 299_999);
      assert.equal((await resend()).status, 429);
      assert.equal((await request(consentHost, path, 'POST', email(inbox.toUpperCase()))).status, 409);
      await setClock(consentHost, tenantJob.at + 300_000);
      assert.equal((await resend()).status, 200);
      assert.equal((await recipient(consentOrigin, 'POST', previous)).status, 400);
      await until(async () => (await capturedMail()).length === 4 && completedBatches === batches.length);
      const newJob = batches.at(-1)[0];
      const next = await latestToken(inbox);
      assert.ok(next !== previous, 'resend issues a different confirmation fragment');
      const beforeReplay = completedBatches;
      await producer.send(newJob);
      await until(() => completedBatches > beforeReplay);
      assert.equal((await capturedMail()).length, 4, 'an already submitted confirmation job does not send again');
      await setClock(consentHost, newJob.at + 86_400_000);
      assert.equal((await recipient(consentOrigin, 'POST', next)).status, 400);

      const beforeRemove = completedBatches;
      let release;
      holdBatch = new Promise(resolve => { release = resolve; });
      try {
        assert.equal((await resend()).status, 200);
        await until(() => batches.length > beforeRemove);
        await json(consentHost, consentPath, 'DELETE');
        assert.equal((await request(consentHost, path, 'POST', email(inbox.toUpperCase()))).status, 429);
      } finally {
        release();
        holdBatch = undefined;
      }
      await until(() => completedBatches > beforeRemove);
      assert.equal((await capturedMail()).length, 4, 'removal prevents a queued confirmation from submitting');
      assert.equal((await recipient(consentOrigin, 'POST', next)).status, 400);
      await setClock(consentHost, newJob.at + 86_400_000 + 300_000);
      const reAdded = await addTenant(inbox);
      assert.notEqual(reAdded.id, consentDestination.id);
      await until(async () => (await capturedMail()).length === 5 && completedBatches === batches.length);
      assert.equal((await recipient(consentOrigin, 'POST', await latestToken(inbox))).status, 200);

      const pauseInbox = 'pause@example.net';
      const priorBatch = batches.length;
      const paused = await addTenant(pauseInbox, '?test-policy-revision=1');
      assert.equal(paused.confirmed, false);
      assert.equal((await request(consentHost, path + '/' + paused.id + '/confirmation', 'POST')).status, 409);
      assert.equal((await json(consentHost, '/api/operator?test-policy-revision=2')).paused, false);
      assert.equal(batches.length, priorBatch);
      await json(consentHost, path + '/' + paused.id + '/confirmation', 'POST');
      await until(async () => (await capturedMail()).length === 6 && completedBatches === batches.length);
      await latestToken(pauseInbox);

      const heldInbox = 'held@example.net';
      const beforePause = completedBatches;
      holdBatch = new Promise(resolve => { release = resolve; });
      try {
        await addTenant(heldInbox);
        await until(() => batches.length > beforePause);
        assert.equal((await json(consentHost, '/api/operator?test-policy-revision=3')).paused, true);
        assert.equal((await json(consentHost, '/api/operator?test-policy-revision=4')).paused, false);
      } finally {
        release();
        holdBatch = undefined;
      }
      await until(() => completedBatches > beforePause);
      assert.equal((await capturedMail()).length, 6, 'pause and resume invalidate a queued confirmation');

      const resendInbox = 'resend-race@example.net';
      const beforeResend = completedBatches;
      holdBatch = new Promise(resolve => { release = resolve; });
      try {
        const destination = await addTenant(resendInbox);
        await until(() => batches.length > beforeResend);
        await setClock(consentHost, batches.at(-1)[0].at + 300_000);
        await json(consentHost, path + '/' + destination.id + '/confirmation', 'POST');
      } finally {
        release();
        holdBatch = undefined;
      }
      await until(() => completedBatches === beforeResend + 2);
      assert.equal((await capturedMail()).filter(message => message.to.includes(resendInbox)).length, 1, 'resend invalidates the older queued confirmation');
      await latestToken(resendInbox);
      assert.ok(errors.every(error => !error.includes('@example.net') &&
        [...capturedTokens].every(token => !error.includes(token))), 'error logs exclude confirmation credentials and recipient addresses');

      await main(async dispatch => {
        const headers = { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' };
        const endpoint = 'https://personal.example' + path;
        assert.equal((await dispatch(endpoint, { method: 'POST', headers, body: JSON.stringify(email(inbox)) })).status, 503);
        const webhook = await dispatch(endpoint, { method: 'POST', headers, body: JSON.stringify({ url: 'https://hooks.example/still-available' }) });
        assert.equal(webhook.status, 201);
        assert.ok(!('emailConfigured' in await webhook.json()));
        const { monitor, destinations } = await (await dispatch('https://personal.example' + monitors, {
          method: 'POST', headers, body: JSON.stringify({ name: 'Webhook-only Monitor', url: 'https://internal.example:8443/target-secret', failureThreshold: 1 }),
        })).json();
        assert.equal((await dispatch('https://personal.example' + monitors + '/' + monitor.id, {
          method: 'PATCH', headers, body: JSON.stringify({ destinationIds: [destinations[0].id] }),
        })).status, 200);
        assert.equal((await dispatch('https://personal.example/test-tick?at=' + (Date.now() + 60_000), { headers })).status, 204);
        await until(async () => {
          const snapshot = await (await dispatch(endpoint, { headers })).json();
          return snapshot.incidents.length === 1 && snapshot.destinations[0].latestSubmission?.status === 'accepted';
        });
      }, false, undefined, packageName);
      await setClock(consentHost, 0);
      console.log('PASS email confirmation: optional setup, hosted roles, consent, cooldown, expiry, cancellation and pause');
    }

    {
      const host = 'confirmation-recovery.example';
      const address = 'retry-confirmation@example.net';
      emailFaults.set(address, 'E_EMAIL_SENDING_NOT_READY');
      let release;
      holdBatch = new Promise(resolve => { release = resolve; });
      const before = completedBatches;
      const beforeMail = (await capturedMail()).length;
      let job;
      try {
        await json(host, path, 'POST', { channel: 'email', address }, 201);
        await until(() => batches.length > before);
        [job] = batches.at(-1);
        confirmationFaults.set(job.deliveryId, 1);
      } finally {
        release();
        holdBatch = undefined;
      }
      await until(() => completedBatches > before);
      assert.deepEqual(actions.at(-1).retry, { delaySeconds: 5 });
      assert.equal((await capturedMail()).length, beforeMail);
      const retrying = (await json(host, path)).destinations[0].latestSubmission;
      assert.equal(retrying.status, 'retrying');
      assert.equal(retrying.reason, 'provider_unavailable');
      await until(() => completedBatches > before + 1, 9000);
      assert.equal((await capturedMail()).length, beforeMail + 1, 'a real broker retry submits the confirmation');
      assert.deepEqual(batches.at(-1), [job], 'the broker retries the original invitation job');
      assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted');
      assert.equal(confirmationReports.filter(report => report.deliveryId === job.deliveryId).length, 1);
      await redeliver(producer, job);
      assert.equal((await capturedMail()).length, beforeMail + 1, 'known acceptance closes confirmation while marking is pending');
      assert.equal(confirmationReports.filter(report => report.deliveryId === job.deliveryId).length, 1);
      await until(() => confirmationReports.filter(report => report.deliveryId === job.deliveryId).length === 2, 9000);
      const captured = (await capturedMail()).find(message => message.to.includes(address));
      const link = await confirmationLink(captured, address);
      assert.equal((await json(host, path)).destinations[0].confirmed, false);
      const recoveryPayload = JSON.stringify(confirmationReports.filter(report => report.deliveryId === job.deliveryId));
      assert.doesNotMatch(recoveryPayload + errors.join('\n'), /retry-confirmation@example\.net|sensitive provider response/);
      assert.ok(!(recoveryPayload + errors.join('\n')).includes(link.hash.slice(1)));
      assert.equal(emailCalls.filter(to => to === address).length, 2);
      const confirmed = await mf.dispatchFetch(new URL(link.pathname, link.origin), {
        method: 'POST', body: new URLSearchParams({ token: link.hash.slice(1) }),
      });
      assert.equal(confirmed.status, 200, 'the retried invitation can still confirm the inbox');
      const rejected = 'permanent-confirmation@example.net';
      const rejectedBatch = completedBatches;
      emailFaults.set(rejected, 'E_RECIPIENT_SUPPRESSED');
      await json(host, path, 'POST', { channel: 'email', address: rejected }, 201);
      await until(() => completedBatches > rejectedBatch);
      assert.equal(actions.at(-1).ack, true);
      assert.equal(emailCalls.filter(to => to === rejected).length, 1);
      assert.equal((await capturedMail()).length, beforeMail + 1);
      assert.equal((await json(host, path)).destinations.find(destination => destination.address === rejected).latestSubmission.reason, 'provider_rejected');
      console.log('PASS confirmation transport recovery: readiness backoff, one acceptance through mark failure, and safe recovery');
    }

    const host = 'personal.example';
    providerStatus = 204;
    const { monitors: withMaintenance } = await json(host, monitors, 'POST', {
      name: 'Private `@here <!everyone>` [link](https://event.example)', url: 'https://internal.example:8443/target-secret',
      published: false,
    }, 201);
    const monitor = withMaintenance.at(-1);
    const monitorPath = monitors + '/' + monitor.id;
    const maintenance = monitorPath + '/maintenance';
    const ids = (await json(host, path)).destinations.filter(destination => destination.channel === 'webhook').map(destination => destination.id);
    await json(host, monitorPath, 'PATCH', { destinationIds: ids });
    const beforeMaintenance = submissions.length;
    const endsAt = at + 25_000;
    const started = (await json(host, maintenance, 'PUT', { endsAt })).monitors.find(item => item.id === monitor.id);
    await until(() => submissions.length === beforeMaintenance + 2 && completedBatches === batches.length);
    for (const { payload } of submissions.slice(beforeMaintenance)) {
      assert.match(payload.text, /Maintenance started/);
      assert.ok(payload.text.includes(new Date(started.maintenance.startedAt).toISOString()));
      assert.ok(payload.text.includes('Scheduled end ' + new Date(endsAt).toISOString()));
      assert.doesNotMatch(payload.text, /@here|<!everyone>|internal\.example|target-secret|hooks\.example|\/token/);
      assert.equal(payload.text.split('`').length, 3, 'only the renderer delimits inline code');
    }
    await json(host, maintenance, 'PUT', { endsAt });
    const revisedEnd = endsAt + 60_000;
    await json(host, maintenance, 'PUT', { endsAt: revisedEnd });
    await until(() => submissions.length === beforeMaintenance + 4 && completedBatches === batches.length);
    assert.match(submissions.at(-1).payload.text, /Maintenance end time changed/);
    assert.ok(submissions.at(-1).payload.text.includes('Previous end ' + new Date(endsAt).toISOString()));
    assert.ok(submissions.at(-1).payload.text.includes('Scheduled end ' + new Date(revisedEnd).toISOString()));
    await holdTransition(host, async () => {
      await json(host, monitorPath, 'PATCH', { destinationIds: [ids[1]] });
      await json(host, monitorPath, 'PATCH', { destinationIds: ids });
      await json(host, maintenance, 'DELETE');
    }, () => json(host, maintenance, 'DELETE'));
    assert.equal(submissions.length, beforeMaintenance + 5, 'only the still-selected destination submits the early end');
    assert.match(submissions.at(-1).payload.text, /Maintenance ended early/);
    const [ended] = batches.at(-1);
    assert.ok(submissions.at(-1).payload.text.includes(new Date(ended.event.at).toISOString()));
    await json(host, maintenance, 'PUT', { endsAt });
    await until(() => submissions.length === beforeMaintenance + 7 && completedBatches === batches.length);
    at = endsAt + 10_000;
    healthy = true;
    await tick(host);
    await until(() => submissions.length === beforeMaintenance + 9 && completedBatches === batches.length);
    assert.match(submissions.at(-1).payload.text, /Maintenance expired/);
    assert.ok(submissions.at(-1).payload.text.includes(new Date(endsAt).toISOString()));
    assert.deepEqual(batches.flat().filter(job => job.monitorId === monitor.id).map(job => job.event.kind), [
      'maintenance.started', 'maintenance.started', 'maintenance.updated', 'maintenance.updated', 'maintenance.ended',
      'maintenance.ended', 'maintenance.started', 'maintenance.started', 'maintenance.ended', 'maintenance.ended',
    ]);
    wallTime = Date.now();
    const { monitors: withWatchdog } = await json(host, monitors, 'POST', {
      name: 'Delayed Watchdog', kind: 'heartbeat', published: false,
    }, 201);
    const watchdog = withWatchdog.at(-1);
    const watchdogPath = monitors + '/' + watchdog.id;
    await json(host, watchdogPath, 'PATCH', { destinationIds: [ids[0]] });
    const silenceAt = wallTime + 180_000;
    const watchdogEnd = wallTime + 185_000;
    const watchdogBatches = completedBatches;
    await json(host, watchdogPath + '/maintenance', 'PUT', { endsAt: watchdogEnd });
    await until(() => completedBatches > watchdogBatches);
    const beforeExpiry = submissions.length;
    wallTime += 190_000;
    at = silenceAt;
    await tick(host);
    const delayed = await json(host, '/api/operator');
    assert.deepEqual(delayed.monitors.find(item => item.id === watchdog.id).lastResult, {
      at: silenceAt, outcome: 'maintenance',
    });
    assert.equal(delayed.monitors.find(item => item.id === watchdog.id).maintenance, null);
    assert.ok(!delayed.incidents.some(incident => incident.monitorId === watchdog.id));
    at = silenceAt;
    await tick(host);
    await until(() => completedBatches > watchdogBatches + 1 && completedBatches === batches.length);
    assert.deepEqual(batches.flat().filter(job => job.monitorId === watchdog.id).map(job => [job.event.kind, job.event.at]), [
      ['maintenance.started', silenceAt - 180_000], ['maintenance.ended', watchdogEnd],
    ]);
    assert.equal(submissions.length, beforeExpiry + 1);
    assert.match(submissions.at(-1).payload.text, /Maintenance expired/);
    assert.ok(submissions.at(-1).payload.text.includes(new Date(watchdogEnd).toISOString()));
    at = watchdogEnd;
    await tick(host);
    await until(() => submissions.length === beforeExpiry + 2 && completedBatches === batches.length);
    assert.match(submissions.at(-1).payload.text, /Incident opened/);
    assert.equal((await json(host, '/api/operator')).incidents.find(incident => incident.monitorId === watchdog.id).openedAt, watchdogEnd);

    const activeHost = 'active-maintenance.example';
    const { destinations: activeDestinations } = await json(activeHost, path, 'POST', { url: 'https://hooks.example/active' }, 201);
    const { monitors: [activeWatchdog] } = await json(activeHost, monitors, 'POST', {
      name: 'Active Maintenance Watchdog', kind: 'heartbeat', published: false,
    }, 201);
    const activePath = monitors + '/' + activeWatchdog.id;
    await json(activeHost, activePath, 'PATCH', { destinationIds: [activeDestinations[0].id] });
    const activeSilence = wallTime + 180_000;
    wallTime = activeSilence + 5_000;
    const activeEnd = activeSilence + 65_000;
    await json(activeHost, activePath + '/maintenance', 'PUT', { endsAt: activeEnd });
    await until(() => submissions.at(-1)?.url === 'https://hooks.example/active' && completedBatches === batches.length);
    at = activeSilence;
    wallTime = activeSilence + 10_000;
    await tick(activeHost);
    const active = await json(activeHost, '/api/operator');
    assert.deepEqual(active.monitors[0].lastResult, { at: activeSilence, outcome: 'maintenance' });
    assert.equal(active.monitors[0].maintenance.endsAt, activeEnd);
    assert.deepEqual(active.incidents, []);
    assert.deepEqual(batches.flat().filter(job => job.monitorId === activeWatchdog.id).map(job => job.event.kind), ['maintenance.started']);
    console.log('PASS delayed Watchdog silence: Maintenance exclusion, one expiry and normal detection at the window end');
    console.log('PASS Maintenance Queue delivery: private fan-out, safe content, no-op, update, early end, selection cancellation and natural expiry');

    const alertHost = 'email-alerts.example';
    const address = 'alert-recipient@example.net';
    const seenInvitations = new Set();
    const addInbox = async (host, address) => (await json(host, path, 'POST', { channel: 'email', address }, 201))
      .destinations.find(destination => destination.address === address);
    const confirmInbox = async (host, address) => {
      const destination = await addInbox(host, address);
      const message = await until(async () => (await capturedMail()).find(message => message.to.includes(address) &&
        message.subject === 'Confirm Irisbeat email notifications' &&
        !seenInvitations.has(message.messageId)));
      seenInvitations.add(message.messageId);
      const link = await confirmationLink(message, address);
      assert.equal(link.host, host);
      const result = await mf.dispatchFetch(link.origin + link.pathname, {
        method: 'POST', body: new URLSearchParams({ token: link.hash.slice(1) }),
      });
      assert.equal(result.status, 200);
      return destination;
    };
    const destination = await confirmInbox(alertHost, address);
    const name = '<img src=x onerror="bad()">& @everyone';
    const { monitor: emailMonitor } = await json(alertHost, monitors, 'POST', {
      name, url: 'https://internal.example:8443/target-secret', published: false, failureThreshold: 1, recoveryThreshold: 1,
    }, 201);
    const emailMonitorPath = monitors + '/' + emailMonitor.id;
    const alertMail = async (inbox = address) => (await capturedMail()).filter(message => message.to.includes(inbox) &&
      message.subject !== 'Confirm Irisbeat email notifications');
    await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [destination.id] });
    at = wallTime + 60_000;
    healthy = false;
    const openedAt = at;
    await tick(alertHost);
    const openedMessage = await until(async () => (await alertMail())[0]);
    const openMail = await capturedMail('&email_id=' + encodeURIComponent(openedMessage.messageId));
    assert.deepEqual(openMail.to, [address]);
    assert.equal(openMail.from, sender);
    assert.match(openMail.subject, /Incident opened/);
    assert.ok(openMail.text.includes(name));
    assert.ok(openMail.text.includes(new Date(openedAt).toISOString()));
    assert.match(openMail.html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;&amp;/);
    assert.doesNotMatch(openMail.html, /<img/);
    assert.doesNotMatch(openMail.text + openMail.html, /internal\.example|8443|target-secret/);
    const href = openMail.text.match(/https:\/\/[^\s]+/)?.[0];
    assert.ok(href);
    const withdraw = new URL(href);
    assert.equal(withdraw.origin + withdraw.pathname, 'https://' + alertHost + '/notifications/unsubscribe');
    assert.ok(withdraw.hash.length > 1);
    assert.ok(openMail.html.includes('href="' + href + '"'));

    const secondAddress = 'second-alert@example.net';
    const second = await confirmInbox(alertHost, secondAddress);
    const webhookUrl = 'https://hooks.example/mixed-alerts';
    const { destinations: mixedDestinations } = await json(alertHost, path, 'POST', { url: webhookUrl }, 201);
    const webhook = mixedDestinations.find(item => item.url === webhookUrl);
    await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [destination.id, second.id, webhook.id] });
    assert.equal((await alertMail(secondAddress)).length, 0, 'confirmation and selection do not replay the open Incident');
    healthy = true;
    const recoveredAt = at;
    const beforeMixed = batches.length;
    emailFaults.set(address, 'E_RATE_LIMIT_EXCEEDED');
    let recoveryJob, webhookJob;
    await holdTransition(alertHost, () => {
      recoveryJob = batches.at(-1).find(job => job.destinationId === destination.id);
      webhookJob = batches.at(-1).find(job => job.destinationId === webhook.id);
    });
    assert.equal(batches[beforeMixed].length, 3, 'the event fans out email and webhook in the same Queue batch');
    assert.ok(actions.some(action => action.id === recoveryJob.deliveryId && action.retry?.delaySeconds === 5));
    assert.ok(actions.some(action => action.id === webhookJob.deliveryId && action.ack));
    const result = async id => (await json(alertHost, path)).destinations.find(item => item.id === id).latestSubmission;
    assert.equal((await result(destination.id)).status, 'retrying');
    assert.equal((await result(destination.id)).reason, 'rate_limited');
    assert.equal((await result(webhook.id)).status, 'accepted');
    assert.equal((await alertMail()).length, 1, 'rate limiting did not reach native email acceptance');

    reportFaults.set(recoveryJob.deliveryId, 100);
    await until(() => actions.some(action => action.id === recoveryJob.deliveryId && action.ack), 10_000);
    assert.equal((await result(destination.id)).status, 'retrying', 'the acceptance report is still unavailable');
    const acceptedMail = (await alertMail()).map(message => message.messageId);
    assert.equal(acceptedMail.length, 2);
    assert.equal(submissions.filter(submission => submission.url === webhookUrl).length, 1);
    assert.ok(submissions.find(submission => submission.url === webhookUrl).payload.text.includes(new Date(recoveredAt).toISOString()));
    await redeliver(producer, recoveryJob);
    assert.deepEqual(actions.at(-1), { id: recoveryJob.deliveryId, ack: true });
    assert.deepEqual((await alertMail()).map(message => message.messageId), acceptedMail,
      'a renewed Queue copy cannot submit a previously accepted email while its report is unavailable');
    reportFaults.delete(recoveryJob.deliveryId);
    await until(async () => (await result(destination.id)).status === 'accepted', 15_000);
    await redeliver(producer, recoveryJob);
    assert.deepEqual((await alertMail()).map(message => message.messageId), acceptedMail,
      'a renewed Queue copy cannot submit a previously accepted email again');
    await json(alertHost, path + '/' + webhook.id, 'DELETE');

    const recovery = async inbox => {
      const message = await until(async () => (await alertMail(inbox)).find(mail => mail.subject === 'Irisbeat: Incident recovered'));
      return capturedMail('&email_id=' + encodeURIComponent(message.messageId));
    };
    for (const inbox of [address, secondAddress]) {
      const mail = await recovery(inbox);
      assert.deepEqual(mail.to, [inbox]);
      assert.ok(mail.text.includes(new Date(recoveredAt).toISOString()));
      assert.ok(mail.text.includes('Opened ' + new Date(openedAt).toISOString()));
    }

    const otherHost = 'other-alerts.example';
    const other = await confirmInbox(otherHost, address);
    const { monitor: publicEmailMonitor } = await json(otherHost, monitors, 'POST', {
      name: 'Public email Monitor', url: 'https://internal.example:8443/target-secret', failureThreshold: 1,
    }, 201);
    await json(otherHost, monitors + '/' + publicEmailMonitor.id, 'PATCH', { destinationIds: [other.id] });
    const { monitors: withSpareMonitor } = await json(alertHost, monitors, 'POST', { name: 'Spare email Monitor', kind: 'heartbeat' }, 201);
    const spareMonitor = withSpareMonitor.at(-1);
    await json(alertHost, monitors + '/' + spareMonitor.id, 'PATCH', { destinationIds: [destination.id] });
    const recipient = (method, origin = withdraw.origin) => mf.dispatchFetch(origin + withdraw.pathname, {
      method, ...(method === 'POST' ? { body: new URLSearchParams({ token: withdraw.hash.slice(1) }) } : {}),
    });
    const snapshot = await json(alertHost, '/api/operator');
    const landing = await recipient('GET');
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer');
    assert.doesNotMatch(await landing.text(), /alert-recipient@example\.net/);
    assert.equal((await recipient('POST', 'https://' + otherHost)).status, 400);
    assert.deepEqual((await json(alertHost, '/api/operator')).destinations, snapshot.destinations,
      'a link fetch or wrong context cannot unsubscribe');

    const emailMaintenance = emailMonitorPath + '/maintenance';
    const expectedEnd = wallTime + 600_000;
    const updatedEnd = expectedEnd + 60_000;
    const beforeWithdrawal = (await alertMail()).length;
    await holdTransition(alertHost, async () => {
      assert.equal((await recipient('POST')).status, 200);
      assert.equal((await recipient('POST')).status, 400);
    }, () => json(alertHost, emailMaintenance, 'PUT', { endsAt: expectedEnd }));
    assert.equal((await alertMail()).length, beforeWithdrawal, 'withdrawal cancels queued Maintenance for the original inbox');
    const unsubscribed = await json(alertHost, '/api/operator');
    assert.deepEqual(unsubscribed.destinations.map(destination => destination.id), [second.id]);
    assert.deepEqual(unsubscribed.monitors.find(item => item.id === emailMonitor.id).destinationIds, [second.id]);
    assert.deepEqual(unsubscribed.monitors.find(item => item.id === spareMonitor.id).destinationIds, []);

    const maintenanceMail = async (subject, detail) => {
      const message = await until(async () => (await alertMail(secondAddress)).find(mail => mail.subject === 'Irisbeat: ' + subject));
      const mail = await capturedMail('&email_id=' + encodeURIComponent(message.messageId));
      assert.deepEqual(mail.to, [secondAddress]);
      assert.ok(mail.text.includes(detail));
      assert.ok(mail.html.includes(detail));
      const link = mail.text.match(/https:\/\/[^\s]+/)?.[0];
      assert.ok(link);
      assert.match(link, /^https:\/\/email-alerts\.example\/notifications\/unsubscribe#[a-f0-9-]{36}$/);
      assert.ok(mail.html.includes('href="' + link + '"'));
      return link;
    };
    const secondWithdrawal = await maintenanceMail('Maintenance started', 'Scheduled end ' + new Date(expectedEnd).toISOString());
    assert.notEqual(secondWithdrawal, href);
    await json(alertHost, emailMaintenance, 'PUT', { endsAt: updatedEnd });
    await maintenanceMail('Maintenance end time changed', 'Previous end ' + new Date(expectedEnd).toISOString());
    await json(alertHost, emailMaintenance, 'DELETE');
    await maintenanceMail('Maintenance ended early', 'Scheduled end ' + new Date(updatedEnd).toISOString());
    await json(alertHost, emailMaintenance, 'PUT', { endsAt: expectedEnd });
    at = expectedEnd;
    await tick(alertHost);
    await maintenanceMail('Maintenance expired', new Date(expectedEnd).toISOString());

    const beforeOther = new Set((await alertMail()).map(message => message.messageId));
    healthy = false;
    await tick(otherHost);
    const publicMessage = await until(async () => (await alertMail()).find(mail => !beforeOther.has(mail.messageId)));
    const publicMail = await capturedMail('&email_id=' + encodeURIComponent(publicMessage.messageId));
    assert.match(publicMail.text, /Incident opened\nPublic email Monitor/);
    assert.match(publicMail.text, /https:\/\/other-alerts\.example\/notifications\/unsubscribe#/);
    assert.ok((await json(otherHost, '/api/status')).incidents.length);

    wallTime = expectedEnd + 1_000;
    const beforeStale = (await alertMail(secondAddress)).length;
    emailFaults.set(secondAddress, 'E_INTERNAL_SERVER_ERROR');
    let stale;
    await holdTransition(alertHost, () => { [stale] = batches.at(-1); },
      () => json(alertHost, emailMaintenance, 'PUT', { endsAt: updatedEnd }));
    assert.deepEqual(actions.at(-1), { id: stale.deliveryId, retry: { delaySeconds: 5 } });
    assert.equal((await result(second.id)).reason, 'provider_unavailable');
    await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [] });
    await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [second.id] });
    await until(() => actions.some(action => action.id === stale.deliveryId && action.ack), 10_000);
    assert.equal((await result(second.id)).status, 'canceled');
    assert.equal((await alertMail(secondAddress)).length, beforeStale, 'reselection cannot revive a retrying alert');
    const replacementAddress = 'replacement-alert@example.net';
    await holdTransition(alertHost, async () => {
      const replacement = await json(alertHost, path + '/' + second.id, 'PUT', { channel: 'email', address: replacementAddress, name: 'Replacement email' });
      const pending = replacement.destinations.find(destination => destination.address === replacementAddress);
      assert.equal(pending.confirmed, false);
      assert.equal(pending.name, 'Replacement email');
      assert.notEqual(pending.id, second.id);
      assert.deepEqual(replacement.monitors.find(item => item.id === emailMonitor.id).destinationIds, []);
      assert.equal((await request(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [pending.id] })).status, 400);
      const oldLink = new URL(secondWithdrawal);
      assert.equal((await mf.dispatchFetch(oldLink.origin + oldLink.pathname, {
        method: 'POST', body: new URLSearchParams({ token: oldLink.hash.slice(1) }),
      })).status, 400);
    }, () => json(alertHost, emailMaintenance, 'DELETE'));
    await redeliver(producer, stale);
    await until(() => completedBatches === batches.length);
    assert.equal((await alertMail(secondAddress)).length, beforeStale);
    assert.equal((await alertMail(replacementAddress)).length, 0);
    wallTime += 300_000;
    const readded = await confirmInbox(alertHost, address);
    assert.notEqual(readded.id, destination.id);
    assert.equal((await recipient('POST')).status, 400, 'the old link cannot remove the same inbox after it confirms again');
    assert.deepEqual((await json(alertHost, '/api/operator')).monitors.find(item => item.id === emailMonitor.id).destinationIds, []);
    assert.ok(!JSON.stringify(batches).includes(withdraw.hash.slice(1)));
    assert.ok(errors.every(error => !error.includes(address) && !error.includes(withdraw.hash.slice(1))));
    console.log('PASS email alerts: native capture, independent webhook acceptance, classified retries, duplicate suppression during report outage, withdrawal and cancellation');

    const mixedHost = 'mixed-pause.example';
    const mixedAddress = 'mixed-pause@example.net';
    const mixedUrl = 'https://hooks.example/mixed-pause-secret';
    const { destinations: [mixedInbox] } = await json(mixedHost, path, 'POST',
      { channel: 'email', address: mixedAddress }, 201,
      { 'X-Forwarded-Host': 'forged.example', 'X-Forwarded-Proto': 'http' });
    const invite = await until(async () => (await capturedMail()).find(message => message.to.includes(mixedAddress)));
    const consent = await confirmationLink(invite, mixedAddress);
    assert.equal(consent.origin, 'https://recipient.example', 'the trusted origin wins over request and forwarded hosts');
    const confirmAt = origin => mf.dispatchFetch(origin + consent.pathname, {
      method: 'POST', body: new URLSearchParams({ token: consent.hash.slice(1) }),
    });
    assert.equal((await confirmAt('https://other-alerts.example')).status, 400);
    assert.equal((await confirmAt('https://' + mixedHost)).status, 400, 'an alias to the same context cannot use the consent token');
    assert.equal((await confirmAt(consent.origin)).status, 200);
    const { destinations: [, mixedHook] } = await json(mixedHost, path, 'POST', { url: mixedUrl }, 201);
    const { monitor: mixedMonitor } = await json(mixedHost, monitors, 'POST', { name: 'Mixed pause', kind: 'heartbeat' }, 201);
    const mixedPath = monitors + '/' + mixedMonitor.id;
    assert.deepEqual(mixedMonitor.destinationIds, []);
    const both = [mixedInbox.id, mixedHook.id];
    const mixedReader = { authorization: 'Bearer reader', 'X-Context-Id': mixedHost, 'X-Permission': 'editor' };
    assert.equal((await request(mixedHost, mixedPath, 'PATCH', { destinationIds: both }, mixedReader)).status, 403);
    assert.equal((await request(mixedHost, path + '/' + mixedInbox.id, 'DELETE', undefined, mixedReader)).status, 403);
    assert.equal((await request(mixedHost, path + '/' + mixedHook.id, 'DELETE', undefined, mixedReader)).status, 403);
    await json(mixedHost, mixedPath, 'PATCH', { destinationIds: both });
    for (const [endpoint, headers] of [['/api/operator', mixedReader], ['/api/operator/destinations', mixedReader],
      ['/api/status', { authorization: '' }], ['/', { authorization: '' }], ['/operator.js', { authorization: '' }]]) {
      const response = await request(mixedHost, endpoint, 'GET', undefined, headers);
      assert.equal(response.status, 200, endpoint);
      const body = await response.text();
      for (const secret of [mixedAddress, mixedUrl, mixedInbox.id, mixedHook.id, consent.hash.slice(1)]) {
        assert.ok(!body.includes(secret), 'private notification data leaked through ' + endpoint);
      }
    }
    const mixedTraffic = () => [emailCalls.filter(address => address === mixedAddress).length,
      submissions.filter(submission => submission.url === mixedUrl).length];
    const policy = async revision => (await json(mixedHost, '/api/operator?test-policy-revision=' + revision)).paused;
    const maintain = async offset => {
      wallTime += 1000;
      await json(mixedHost, mixedPath + '/maintenance', 'PUT', { endsAt: wallTime + offset });
    };
    const baseline = mixedTraffic();
    await holdTransition(mixedHost, async () => {
      assert.equal(await policy(1), true);
      const before = batches.length;
      await maintain(620_000);
      assert.equal(batches.length, before, 'paused Maintenance does not enqueue either channel');
      assert.equal(await policy(2), false);
    }, () => maintain(600_000));
    assert.deepEqual(mixedTraffic(), baseline, 'queued email and webhook are canceled across pause and resume');
    assert.equal((await alertMail(mixedAddress)).length, 0);
    assert.deepEqual((await json(mixedHost, path)).destinations.map(destination => destination.latestSubmission?.status),
      ['accepted', undefined], 'never-attempted alerts leave Settings results alone');

    // Email accepts while only the webhook retries. Then both channels retry across pause.
    providerStatuses.set(mixedUrl, 429);
    let mixedJobs;
    const controlMixedBatch = () => {
      mixedJobs = batches.at(-1);
      assert.deepEqual(mixedJobs.map(job => job.destinationId).sort(), [...both].sort());
      for (const job of mixedJobs) controls.set(job.deliveryId, { attempts: 1 });
    };
    await holdTransition(mixedHost, controlMixedBatch, () => maintain(630_000));
    assert.deepEqual((await json(mixedHost, path)).destinations.map(destination => destination.latestSubmission.status),
      ['accepted', 'retrying']);
    assert.equal((await alertMail(mixedAddress)).length, 1);
    emailFaults.set(mixedAddress, 'E_INTERNAL_SERVER_ERROR');
    await holdTransition(mixedHost, controlMixedBatch, () => maintain(640_000));
    assert.deepEqual((await json(mixedHost, path)).destinations.map(destination => destination.latestSubmission.status),
      ['retrying', 'retrying']);
    assert.equal(await policy(3), true);
    const beforeRetries = mixedTraffic();
    for (const job of mixedJobs) await redeliver(producer, job);
    assert.equal(await policy(4), false);
    for (const job of mixedJobs) await redeliver(producer, job);
    assert.deepEqual(mixedTraffic(), beforeRetries, 'neither channel can retry during or after pause');
    assert.deepEqual((await json(mixedHost, path)).destinations.map(destination => destination.latestSubmission.status),
      ['canceled', 'canceled']);

    providerStatuses.set(mixedUrl, 204);
    const beforeFresh = completedBatches;
    await maintain(650_000);
    await until(() => completedBatches > beforeFresh);
    assert.deepEqual(mixedTraffic(), beforeRetries.map(count => count + 1));
    const [emailOrigin] = batches.at(-1).filter(job => job.destinationId === mixedInbox.id);
    const beforeLimits = mixedTraffic();
    const beforeLetters = deadLetters.length;
    for (const [reason, control] of [
      ['expired', { timestamp: Date.now() - 3_600_000 }],
      ['attempts_exhausted', { attempts: 11 }],
    ]) {
      const job = { ...emailOrigin, deliveryId: reason + ':' + mixedInbox.id };
      controls.set(job.deliveryId, control);
      await redeliver(producer, job);
      await until(() => deadLetters.find(letter => letter.deliveryId === job.deliveryId && letter.reason === reason));
    }
    assert.deepEqual(mixedTraffic(), beforeLimits, 'expired and broker-exhausted email never invokes the binding');
    const exhausted = { ...emailOrigin, deliveryId: 'email-provider-budget:' + mixedInbox.id };
    for (let attempts = 1; attempts <= 10; attempts++) {
      emailFaults.set(mixedAddress, 'E_INTERNAL_SERVER_ERROR');
      controls.set(exhausted.deliveryId, { attempts });
      await redeliver(producer, exhausted);
      assert.deepEqual(actions.at(-1), attempts < 10
        ? { id: exhausted.deliveryId, retry: { delaySeconds: 5 * 2 ** (attempts - 1) } }
        : { id: exhausted.deliveryId, ack: true });
    }
    const exhaustedLetter = await until(() => deadLetters.find(letter => letter.deliveryId === exhausted.deliveryId));
    assert.equal(exhaustedLetter.attempts, 10);
    assert.equal(exhaustedLetter.reason, 'attempts_exhausted');
    await redeliver(producer, exhausted);
    assert.deepEqual(mixedTraffic(), [beforeLimits[0] + 10, beforeLimits[1]]);
    assert.doesNotMatch(JSON.stringify(deadLetters.slice(beforeLetters)), /mixed-pause@example|mixed-pause-secret|Mixed pause/);
    console.log('PASS mixed hosted delivery: trusted canonical origin, role and projection guards, independent retries in both directions, pause before and between attempts, and sanitized age/attempt exhaustion');

  } finally {
    await mf.dispose();
  }
}
async function testUpgrade() {
  const temporary = mkdtempSync(join(tmpdir(), 'irisbeat-email-upgrade-'));
  const base = '2f1fba80b7fa6bed019298c41844c5201b28a600'; // #82, the confirmation-only integration revision.
  try {
    const archive = execFileSync('git', ['archive', base, 'src']);
    execFileSync('tar', ['-x', '-C', temporary], { input: archive });
    const old = await deliveryBundles(join(temporary, 'src'), false);
    await main(undefined, true, { old, persist: join(temporary, 'state') });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

exports.withDelivery = main;
exports.testInstalledDelivery = () => main(undefined, true, undefined, 'irisbeat');
if (require.main === module) (process.argv.includes('--upgrade') ? testUpgrade() : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
