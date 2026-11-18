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

async function bundle(contents) {
  return (await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    nodePaths: [join(process.cwd(), 'node_modules')],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', 'cloudflare:sockets'],
  })).outputFiles[0].text;
}

async function deliveryBundles(source = './src') {
  const monitoring = await bundle(`
    import personal, { createHostedWorker, MonitoringContext as EngineContext } from ${JSON.stringify(source + '/index.ts')};
    export { NotificationDelivery } from ${JSON.stringify(source + '/index.ts')};
    const realNow = Date.now;
    let testTime;
    Date.now = () => testTime ?? realNow();
    export class MonitoringContext extends EngineContext {
      setTestTime(at) { testTime = at; }
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
          notificationOrigin: url.hostname === 'no-email.example' ? undefined : url.origin,
          ...(revision === null ? {} : policy(revision)),
        };
      },
      contexts: env => [env.testContext],
    });
    const systemNow = Date.now;
    let wallTime;
    Date.now = () => wallTime ?? systemNow();
    export default {
      fetch(request, env) {
        const wall = request.headers.get('x-test-wall-time');
        wallTime = wall === null ? undefined : Number(wall);
        const url = new URL(request.url);
        const app = url.hostname === 'personal.example' ? personal : hosted;
        if (url.pathname === '/test-clock') {
          const id = url.hostname === 'personal.example' ? 'personal' : url.hostname;
          return env.MONITORING.getByName(id).setTestTime(Number(url.searchParams.get('at')) || undefined).then(() => new Response(null, { status: 204 }));
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
    };`);
  const consumer = await bundle(`
    import delivery from ${JSON.stringify(source + '/notification-delivery.ts')};
    export { NotificationEmailCapability } from ${JSON.stringify(source + '/notification-delivery.ts')};
    export default {
      async queue(batch, env, ctx) {
        await env.GATE.fetch('https://test.example/batch', { method: 'POST', body: JSON.stringify(batch.messages.map(message => message.body)) });
        await delivery.queue(batch, env, ctx);
        await env.GATE.fetch('https://test.example/done', { method: 'POST' });
      },
    };`);
  return { monitoring, consumer };
}

async function main(runFixture, emailEnabled = true, upgrade) {
  const current = await deliveryBundles();
  const batches = [], submissions = [], errors = [];
  const sender = 'alerts@sender.example';
  const capturedTokens = new Set();
  let targetRequests = 0;
  let healthy = false;
  let holdBatch, holdProvider, providerStartedAt;
  let completedBatches = 0;
  let providerStatus = 204;
  const options = ({ monitoring, consumer }) => convertV4MiniflareOptions({
    ...(upgrade ? { durableObjectsPersist: upgrade.persist } : {}),
    unsafeLocalExplorer: emailEnabled,
    log: new Log(LogLevel.NONE),
    handleStructuredLogs: log => { if (log.level === 'error') errors.push(log.message); },
    workers: [
      { name: 'monitoring', modules: true, script: monitoring, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: 'test-installation-secret', NOTIFICATION_PUBLIC_ORIGIN: 'https://personal.example' },
        serviceBindings: { NOTIFICATION_EMAIL: { name: 'delivery', entrypoint: 'NotificationEmailCapability' } },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { NOTIFICATION_QUEUE: 'notifications' },
        outboundService: request => {
          assert.equal(request.url, 'https://internal.example:8443/target-secret');
          targetRequests++;
          return new Response(null, { status: healthy ? 204 : 503 });
        },
      },
      { name: 'delivery', modules: true, script: consumer, compatibilityDate: '2026-11-18',
        bindings: { EMAIL_FROM: sender },
        ...(emailEnabled ? { email: { send_email: [{ name: 'EMAIL' }] } } : {}),
        queueConsumers: { notifications: { maxBatchTimeout: 0.1, maxRetries: 0 } },
        serviceBindings: {
          NOTIFICATION_DELIVERY: { name: 'monitoring', entrypoint: 'NotificationDelivery' },
          GATE: async request => {
            if (new URL(request.url).pathname === '/batch') {
              batches.push(await request.json());
              await holdBatch;
            } else {
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
          if (holdProvider) {
            providerStartedAt = performance.now();
            await holdProvider;
          }
          return new Response(providerStatus === 204 ? null : 'sensitive provider response', {
            status: providerStatus, headers: { Location: 'https://redirect.example/secret' },
          });
        },
      },
    ],
  });
  const mf = new Miniflare(options(upgrade?.old ?? current));
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
        selected.push({ destination, monitor, messageId: message.messageId });
      }
      await mf.setOptions(options(current));

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
      assert.equal(personalStatus.destinations[0].confirmed, true);
      assert.deepEqual(personalStatus.monitor.destinationIds, [selected[0].destination.id]);
      const hostedStatus = await json(hosts[1], '/api/operator');
      assert.deepEqual(hostedStatus.destinations, []);
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
        assert.deepEqual(Object.keys(job.event).sort(), ['at', 'id', 'incidentId', 'kind', 'monitorName', 'openedAt']);
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
        providerStatus = 307;
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
        const priorSubmissions = submissions.length;
        const priorErrors = errors.length;
        await redeliver(producer, pausedJob);
        assert.equal(submissions.length, priorSubmissions, 'an attempted job cannot submit again while paused');
        assert.equal((await json(host, '/api/operator?test-policy-revision=4')).paused, false);
        await redeliver(producer, resumedJob);
        assert.equal(submissions.length, priorSubmissions, 'pause and resume between attempts permanently invalidate the job');
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
          const beforeErrors = errors.length;
          await tick(host);
          await until(() => submissions.length === priorSubmissions + 2);
          // The simulated provider stays unanswered while the real delivery deadline runs.
          await until(() => completedBatches > beforeDeadline && errors.length > beforeErrors, 13_000);
          assert.ok(performance.now() - providerStartedAt >= 9500, 'the held provider reaches the configured deadline');
          assert.deepEqual(errors.slice(beforeErrors), [JSON.stringify({ event: 'webhook_submission_failed' })]);
          assert.equal(submissions.length, priorSubmissions + 2, 'the held submission is attempted once');
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
      assert.equal(pending.confirmed, false);
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
      assert.equal(replacement.destinations.find(destination => destination.address === 'replacement@example.net').confirmed, false);
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
      }, false);
      await setClock(consentHost, 0);
      console.log('PASS email confirmation: optional setup, hosted roles, consent, cooldown, expiry, cancellation and pause');
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
    await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [destination.id, second.id] });
    assert.equal((await alertMail(secondAddress)).length, 0, 'confirmation and selection do not replay the open Incident');
    healthy = true;
    const recoveredAt = at;
    await tick(alertHost);
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

    const beforeStale = (await alertMail(secondAddress)).length;
    await holdTransition(alertHost, async () => {
      await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [] });
      await json(alertHost, emailMonitorPath, 'PATCH', { destinationIds: [second.id] });
    }, () => json(alertHost, emailMaintenance, 'PUT', { endsAt: updatedEnd }));
    assert.equal((await alertMail(secondAddress)).length, beforeStale, 'reselection cannot revive a queued alert');
    const stale = batches.at(-1)[0];
    const replacementAddress = 'replacement-alert@example.net';
    await holdTransition(alertHost, async () => {
      const replacement = await json(alertHost, path + '/' + second.id, 'PUT', { channel: 'email', address: replacementAddress });
      const pending = replacement.destinations.find(destination => destination.address === replacementAddress);
      assert.equal(pending.confirmed, false);
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
    console.log('PASS email alerts: native capture, Incidents and Maintenance, context-scoped withdrawal, replacement and stale selections');
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
    const old = await deliveryBundles(join(temporary, 'src'));
    await main(undefined, true, { old, persist: join(temporary, 'state') });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

exports.withDelivery = main;
if (require.main === module) (process.argv.includes('--upgrade') ? testUpgrade() : main())
  .catch(error => { console.error(error); process.exitCode = 1; });
