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
    export { NotificationDelivery } from './src/index.ts';
    export class MonitoringContext extends EngineContext {
      restartForTest() { this.ctx.abort('Local Queue restart drill'); }
    }
    const hosted = createHostedWorker({
      contractVersion: '1',
      resolve(request) {
        const url = new URL(request.url);
        const revision = url.searchParams.get('test-policy-revision');
        return {
          id: url.hostname, permission: 'editor', monitorLimit: 10,
          ...(revision === null ? {} : { paused: revision === '1', policyRevision: Number(revision) }),
        };
      },
      contexts: () => ['tenant.example'],
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
        if (url.pathname === '/test-tick')
          return app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) }, env).then(() => new Response(null, { status: 204 }));
        return app.fetch(request, env);
      },
    };`);
  const consumer = await bundle(`
    import delivery from './src/notification-delivery.ts';
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
            if (overrides[index]) message.ack();
            else message.retry(options);
          },
        })) }, env, ctx);
        await env.GATE.fetch('https://test.example/done', { method: 'POST', body: JSON.stringify(actions) });
      },
    };`);

  const batches = [], submissions = [], errors = [], actions = [], deadLetters = [];
  const controls = new Map();
  const providerStatuses = new Map();
  let healthy = false;
  let holdBatch, holdProvider, heldEventTime, providerStartedAt;
  let completedBatches = 0;
  let providerStatus = 204;
  const options = {
    handleStructuredLogs: log => { if (log.level === 'error') errors.push(log.message); },
    workers: [
      { name: 'monitoring', modules: true, script: monitoring, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: 'test-installation-secret' },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { NOTIFICATION_QUEUE: 'notifications' },
        outboundService: request => {
          assert.equal(request.url, 'https://internal.example:8443/target-secret');
          return new Response(null, { status: healthy ? 204 : 503 });
        },
      },
      { name: 'delivery', modules: true, script: consumer, compatibilityDate: '2026-11-18',
        queueConsumers: {
          notifications: { maxBatchTimeout: 0.1, maxRetries: 10, deadLetterQueue: 'dead-letters' },
          'dead-letters': { maxBatchTimeout: 0.1 },
        },
        queueProducers: { NOTIFICATION_DLQ: 'dead-letters' },
        serviceBindings: {
          NOTIFICATION_DELIVERY: { name: 'monitoring', entrypoint: 'NotificationDelivery' },
          GATE: async request => {
            const path = new URL(request.url).pathname;
            if (path === '/batch') {
              const messages = await request.json();
              batches.push(messages.map(message => message.body));
              await holdBatch;
              return Response.json(messages.map(message => {
                const control = controls.get(message.body.deliveryId);
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
          },
        },
        outboundService: async request => {
          const submission = { url: request.url };
          submissions.push(submission);
          if (new URL(request.url).hostname === 'redirect.example') return new Response(null, { status: 204 });
          submission.payload = await request.json();
          const status = providerStatuses.get(request.url) ?? providerStatus;
          if (holdProvider && (!heldEventTime || submission.payload.text.includes(heldEventTime))) {
            providerStartedAt = performance.now();
            await holdProvider;
            if (heldEventTime) return new Response('sensitive provider response', { status: 403 });
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
  const request = (host, endpoint, method = 'GET', value) => mf.dispatchFetch('https://' + host + endpoint, {
    method, headers: { authorization: 'Bearer test-installation-secret', 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  async function json(host, endpoint, method, value, expected = 200) {
    const response = await request(host, endpoint, method, value);
    assert.equal(response.status, expected, endpoint);
    return response.json();
  }
  async function tick(host) {
    assert.equal((await request(host, '/test-tick?at=' + at)).status, 204);
    at += 60_000;
  }
  async function until(condition, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!condition()) {
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
        const [destination] = (await json(host, '/api/operator')).destinations;
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
        let releaseProvider;
        holdProvider = new Promise(resolve => { releaseProvider = resolve; });
        try {
          const beforeDeadline = completedBatches;
          await tick(host);
          await until(() => submissions.length === before + 5);
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
          assert.equal(submissions.length, before + 5, 're-selection cancels a pending retry');
          assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'canceled');
        } finally {
          releaseProvider();
          holdProvider = undefined;
        }
      }
    }
    await deletePersonalMonitor();

    const host = 'tenant.example';
    const snapshot = await json(host, '/api/operator');
    const monitorPath = monitors + '/' + snapshot.monitor.id;
    const [first, second] = snapshot.destinations;
    await json(host, monitorPath, 'PATCH', { destinationIds: [first.id, second.id] });
    healthy = true;
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

    const pendingJob = job(firstOrigin, 'queued-before-restart', 6000);
    await producer.send(pendingJob, { delaySeconds: 1 });
    assert.equal((await request(host, '/test-restart?context=' + pendingJob.contextId)).status, 204);
    const queuedAction = () => actions.find(action => action.id === pendingJob.deliveryId);
    assert.equal(queuedAction(), undefined, 'the job is still queued when the MonitoringContext restarts');
    await until(() => queuedAction());
    assert.equal(queuedAction().ack, true);

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
    assert.equal((await json(host, path)).destinations[0].latestSubmission.status, 'accepted');
    console.log('PASS real Queue delivery: independent ack/retry, 5–1280s backoff, deadline, ten attempts, one-hour age, DLQ, cancellation, out-of-order results and restart-safe completion');
  } finally {
    await mf.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
