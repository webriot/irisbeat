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
      fetch(request, env) {
        const url = new URL(request.url);
        const app = url.hostname === 'personal.example' ? personal : hosted;
        if (url.pathname === '/test-tick')
          return app.scheduled({ scheduledTime: Number(url.searchParams.get('at')) }, env).then(() => new Response(null, { status: 204 }));
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
          const beforeErrors = errors.length;
          await tick(host);
          await until(() => submissions.length === before + 5);
          // The simulated provider stays unanswered while the real delivery deadline runs.
          await until(() => completedBatches > beforeDeadline && errors.length > beforeErrors, 13_000);
          assert.ok(performance.now() - providerStartedAt >= 9500, 'the held provider reaches the configured deadline');
          assert.deepEqual(errors.slice(beforeErrors), [JSON.stringify({ event: 'webhook_submission_failed' })]);
          assert.equal(submissions.length, before + 5, 'the held submission is attempted once');
        } finally {
          releaseProvider();
          holdProvider = undefined;
        }
      }
    }
    await deletePersonalMonitor();
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
    console.log('PASS Maintenance Queue delivery: private fan-out, safe content, no-op, update, early end, selection cancellation and natural expiry');
    console.log('PASS real Queue delivery: opt-in, fan-out, safe content, redirects, deadline, tenant isolation and cancellation across selection, deletion and pause');
  } finally {
    await mf.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
