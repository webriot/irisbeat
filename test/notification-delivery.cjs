// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const localRequire = createRequire(join(process.cwd(), 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');

async function bundle(contents) {
  return (await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', 'cloudflare:sockets'],
  })).outputFiles[0].text;
}

async function main() {
  const monitoring = await bundle(`
    import personal, { createHostedWorker, MonitoringContext as EngineContext } from './src/index.ts';
    import { NotificationDelivery as EngineDelivery } from './src/index.ts';
    export class NotificationDelivery extends EngineDelivery {
      async reportSubmission(job, report) {
        const response = await this.env.GATE.fetch('https://test.example/report', {
          method: 'POST', body: JSON.stringify({ job, report }),
        });
        if (!response.ok) throw new Error('Injected result RPC failure');
        return super.reportSubmission(job, report);
      }
    }
    export class MonitoringContext extends EngineContext {
      restartForTest() { this.ctx.abort('Local Queue restart drill'); }
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
        return {
          id: url.hostname, monitorLimit: 10,
          permission: token === 'Bearer test-installation-secret' ? 'editor' : token === 'Bearer reader' ? 'reader' : null,
          ...(revision === null ? {} : policy(revision)),
        };
      },
      contexts: env => [env.testContext],
    });
    export default {
      async fetch(request, env) {
        const url = new URL(request.url);
        const app = url.hostname === 'personal.example' ? personal : hosted;
        if (url.pathname === '/test-restart') {
          const id = env.MONITORING.idFromString(url.searchParams.get('context'));
          await env.MONITORING.get(id).restartForTest().catch(() => {});
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/test-tick') {
          const revision = url.searchParams.get('test-policy-revision');
          const testContext = revision === null ? url.hostname : { id: url.hostname, ...policy(revision) };
          return app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) }, { ...env, testContext }).then(() => new Response(null, { status: 204 }));
        }
        return app.fetch(request, env);
      },
    };`);
  const consumer = await bundle(`
    import delivery, { NotificationRecovery as Recovery } from './src/notification-delivery.ts';
    export class NotificationRecovery extends Recovery {
      constructor(ctx, env) { super(ctx, faultDLQ(env)); }
      async record(identity, report, letter) {
        const response = await this.env.GATE.fetch('https://test.example/persist', {
          method: 'POST', body: JSON.stringify(identity),
        });
        if (!response.ok) throw new Error('Injected recovery persistence failure');
        return super.record(identity, report, letter);
      }
    }
    function faultDLQ(env) {
      return { ...env, NOTIFICATION_DLQ: { async send(letter) {
        const response = await env.GATE.fetch('https://test.example/dlq-write', { method: 'POST', body: JSON.stringify(letter) });
        if (!response.ok) throw new Error('Injected DLQ write failure');
        await env.NOTIFICATION_DLQ.send(letter);
      } } };
    }
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
    };`);

  const batches = [], submissions = [], errors = [], actions = [], deadLetters = [];
  const controls = new Map();
  const providerStatuses = new Map();
  let targetRequests = 0;
  let healthy = false;
  let holdBatch, holdProvider, heldEventTime, providerStartedAt;
  let completedBatches = 0;
  const reportFaults = new Map();
  const recoveryFaults = new Map();
  const dlqFaults = new Set();
  const reportAttempts = [], dlqAttempts = [];
  const gate = async request => {
    const path = new URL(request.url).pathname;
    if (path === '/report') {
      const { job } = await request.json();
      reportAttempts.push(job.deliveryId);
      const remaining = reportFaults.get(job.deliveryId) ?? 0;
      if (remaining) {
        reportFaults.set(job.deliveryId, remaining - 1);
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    }
    if (path === '/persist') {
      const { deliveryId } = await request.json();
      const remaining = recoveryFaults.get(deliveryId) ?? 0;
      if (remaining) recoveryFaults.set(deliveryId, remaining - 1);
      return new Response(null, { status: remaining ? 503 : 204 });
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
  const options = {
    handleStructuredLogs: log => { if (log.level === 'error') errors.push(log.message); },
    workers: [
      { name: 'monitoring', modules: true, script: monitoring, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: 'test-installation-secret' },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { NOTIFICATION_QUEUE: 'notifications', FINAL_QUEUE: 'final-notifications' },
        serviceBindings: { GATE: gate },
        outboundService: request => {
          assert.equal(request.url, 'https://internal.example:8443/target-secret');
          targetRequests++;
          return new Response(null, { status: healthy ? 204 : 503 });
        },
      },
      { name: 'delivery', modules: true, script: consumer, compatibilityDate: '2026-11-18',
        durableObjects: { NOTIFICATION_RECOVERY: { className: 'NotificationRecovery', useSQLite: true } },
        queueConsumers: {
          notifications: { maxBatchTimeout: 0.1, maxRetries: 10 },
          'final-notifications': { maxBatchTimeout: 0.1, maxRetries: 0 },
          'dead-letters': { maxBatchTimeout: 0.1 },
        },
        queueProducers: { NOTIFICATION_DLQ: 'dead-letters', NOTIFICATION_OUTCOMES: 'notifications' },
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
            if (fail) return new Response('sensitive provider response', { status: 403 });
          }
          return new Response(status === 204 ? null : 'sensitive provider response', {
            status, headers: { Location: 'https://redirect.example/secret' },
          });
        },
      },
    ],
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  let at = Date.now();
  const path = '/api/operator/destinations';
  const monitors = '/api/operator/monitors';
  const request = (host, endpoint, method = 'GET', value, headers = {}) => mf.dispatchFetch('https://' + host + endpoint, {
    method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json', ...headers },
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
    while (!await condition()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the Queue consumer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async function holdTransition(host, change) {
    const priorBatches = batches.length;
    let release;
    holdBatch = new Promise(resolve => { release = resolve; });
    try {
      await tick(host);
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
    const producer = await mf.getQueueProducer('NOTIFICATION_QUEUE', 'monitoring');
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
        assert.doesNotMatch(payload.text, /@everyone|<!channel>|<@&123>|internal\.example|8443|target-secret/);
      }
      assert.doesNotMatch(JSON.stringify(batches), /internal\.example|8443|target-secret|hooks\.example|\/token/);

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

    for (const [status, attempts, reason] of [[403, 1, 'provider_rejected'], [429, 10, 'attempts_exhausted']]) {
      const terminal = job(firstOrigin, 'terminal-report-outage-' + status, 8800 + status);
      const beforeTerminal = submissions.length;
      const beforeReports = reportAttempts.length;
      reportFaults.set(terminal.deliveryId, 1);
      providerStatuses.set(first.url, status);
      assert.deepEqual(await sendBatch([terminal], [{ attempts }]), [{ id: terminal.deliveryId, ack: true }]);
      assert.equal(reportAttempts[beforeReports], terminal.deliveryId);
      assert.notEqual((await json(host, path)).destinations[0].latestSubmission.reason, reason);
      assert.deepEqual(await sendBatch([terminal], [{ attempts: 1 }]), [{ id: terminal.deliveryId, ack: true }]);
      assert.equal(submissions.length, beforeTerminal + 1, 'terminal failures close submission during a result RPC outage');
      await until(async () => (await json(host, path)).destinations[0].latestSubmission.reason === reason, 9000);
    }

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
    assert.equal(deadLetters.at(-1).attempts, 11);
    assert.doesNotMatch(JSON.stringify(deadLetters.at(-1)) + errors.join('\n'), /Retry Monitor|target-secret|sensitive provider response|https:\/\//);

    const unavailable = job(firstOrigin, 'final-persistence-outage', 11_000);
    const beforeFallback = completedBatches;
    const beforeFallbackResult = (await json(host, path)).destinations[0].latestSubmission;
    controls.set(unavailable.deliveryId, { attempts: 11 });
    recoveryFaults.set(unavailable.deliveryId, 2);
    reportFaults.set(unavailable.deliveryId, 1);
    await finalProducer.send(unavailable);
    await until(() => completedBatches > beforeFallback);
    assert.ok(actions.some(action => action.id === unavailable.deliveryId && action.ack),
      'the broker’s final delivery hands off the outcome before acknowledging the source');
    await until(() => deadLetters.some(letter => letter.deliveryId === unavailable.deliveryId), 15_000);
    const diagnostic = deadLetters.find(letter => letter.deliveryId === unavailable.deliveryId);
    assert.deepEqual(Object.keys(diagnostic).sort(), ['attempts', 'contextId', 'deliveryId', 'destinationId', 'queuedAt', 'reason']);
    assert.equal(diagnostic.attempts, 11);
    assert.equal(diagnostic.reason, 'attempts_exhausted');
    await until(async () => {
      const result = (await json(host, path)).destinations[0].latestSubmission;
      return result.reason === 'attempts_exhausted' && result.at !== beforeFallbackResult.at;
    }, 15_000);
    assert.equal(reportAttempts.filter(id => id === unavailable.deliveryId).length, 2);
    const handoffs = batches.flat().filter(body => body.identity?.deliveryId === unavailable.deliveryId);
    assert.equal(handoffs.length, 2, 'the sanitized handoff survives its own transient persistence failure');
    assert.deepEqual(handoffs[0], handoffs[1]);
    assert.deepEqual(handoffs[0], {
      identity: { contextId: unavailable.contextId, destinationId: unavailable.destinationId, deliveryId: unavailable.deliveryId },
      submissionReport: {
        eventAt: unavailable.event.at, queuedAt: diagnostic.queuedAt, attempt: 11,
        result: { status: 'failed', reason: 'attempts_exhausted', at: (await json(host, path)).destinations[0].latestSubmission.at },
      },
      exhaustion: 'attempts_exhausted',
    });
    assert.equal(submissions.length, beforeFinal, 'bookkeeping retries cannot call the provider');
    assert.doesNotMatch(JSON.stringify(diagnostic) + errors.join('\n'), /Retry Monitor|target-secret|sensitive provider response|https:\/\//);

    const beforeRestart = submissions.length;
    options.workers[0].script += '\n// Restart monitoring after acceptance';
    options.workers[1].script += '\n// Restart delivery after acceptance';
    await mf.setOptions(convertV4MiniflareOptions(options));
    const restartedProducer = await mf.getQueueProducer('NOTIFICATION_QUEUE', 'monitoring');
    const beforeReplay = actions.length;
    await restartedProducer.sendBatch([older, newer, successfulJob].map(body => ({ body })));
    await until(() => actions.length === beforeReplay + 3);
    assert.ok(actions.slice(beforeReplay).every(action => action.ack));
    assert.equal(submissions.length, beforeRestart, 'completed identities survive restart, including out-of-order completion');
    assert.equal((await json(host, path)).destinations[0].latestSubmission.reason, 'attempts_exhausted');
    console.log('PASS real Queue delivery: independent ack/retry, deadline and limits, cancellation, submission ordering, durable result recovery and safe DLQ recovery');
  } finally {
    await mf.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
