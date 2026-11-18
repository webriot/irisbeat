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
    import personal, { createHostedWorker } from './src/index.ts';
    export { MonitoringContext, NotificationDelivery } from './src/index.ts';
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
    const systemNow = Date.now;
    let wallTime;
    Date.now = () => wallTime ?? systemNow();
    export default {
      fetch(request, env) {
        const wall = request.headers.get('x-test-wall-time');
        wallTime = wall === null ? undefined : Number(wall);
        const url = new URL(request.url);
        const app = url.hostname === 'personal.example' ? personal : hosted;
        if (url.pathname === '/test-tick') {
          const revision = url.searchParams.get('test-policy-revision');
          const testContext = revision === null ? url.hostname : { id: url.hostname, ...policy(revision) };
          return app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) }, { ...env, testContext }).then(() => new Response(null, { status: 204 }));
        }
        return app.fetch(request, env);
      },
    };`);
  const consumer = await bundle(`
    import delivery from './src/notification-delivery.ts';
    export default {
      async queue(batch, env, ctx) {
        await env.GATE.fetch('https://test.example/batch', { method: 'POST', body: JSON.stringify(batch.messages.map(message => message.body)) });
        await delivery.queue(batch, env, ctx);
        await env.GATE.fetch('https://test.example/done', { method: 'POST' });
      },
    };`);

  const batches = [], submissions = [], errors = [];
  let targetRequests = 0;
  let healthy = false;
  let holdBatch, holdProvider, providerStartedAt;
  let completedBatches = 0;
  let providerStatus = 204;
  const mf = new Miniflare(convertV4MiniflareOptions({
    handleStructuredLogs: log => { if (log.level === 'error') errors.push(log.message); },
    workers: [
      { name: 'monitoring', modules: true, script: monitoring, compatibilityDate: '2026-11-13',
        bindings: { INSTALLATION_SECRET: 'test-installation-secret' },
        durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
        queueProducers: { NOTIFICATION_QUEUE: 'notifications' },
        outboundService: request => {
          assert.equal(request.url, 'https://internal.example:8443/target-secret');
          targetRequests++;
          return new Response(null, { status: healthy ? 204 : 503 });
        },
      },
      { name: 'delivery', modules: true, script: consumer, compatibilityDate: '2026-11-18',
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
  }));
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
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the Queue consumer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
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

    const host = 'personal.example';
    providerStatus = 204;
    const { monitor } = await json(host, monitors, 'POST', {
      name: 'Private `@here <!everyone>` [link](https://event.example)', url: 'https://internal.example:8443/target-secret',
      published: false,
    }, 201);
    const monitorPath = monitors + '/' + monitor.id;
    const maintenance = monitorPath + '/maintenance';
    const ids = (await json(host, path)).destinations.map(destination => destination.id);
    await json(host, monitorPath, 'PATCH', { destinationIds: ids });
    const beforeMaintenance = submissions.length;
    const endsAt = at + 25_000;
    const { monitor: started } = await json(host, maintenance, 'PUT', { endsAt });
    await until(() => submissions.length === beforeMaintenance + 2 && completedBatches === batches.length);
    for (const { payload } of submissions.slice(beforeMaintenance)) {
      assert.match(payload.text, /Maintenance started/);
      assert.ok(payload.text.includes(new Date(started.maintenance.startedAt).toISOString()));
      assert.ok(payload.text.includes('Scheduled end ' + new Date(endsAt).toISOString()));
      assert.doesNotMatch(payload.text, /@here|<!everyone>|internal\.example|8443|target-secret|hooks\.example|\/token/);
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
  } finally {
    await mf.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
