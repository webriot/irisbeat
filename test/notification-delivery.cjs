// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { build } = createRequire(join(process.cwd(), 'node_modules/@cloudflare/vitest-plugin/package.json'))('esbuild');
const { Miniflare, convertV4MiniflareOptions } = createRequire(join(process.cwd(), 'node_modules/@cloudflare/vitest-plugin/package.json'))('miniflare');

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
      resolve: request => ({ id: new URL(request.url).hostname, permission: 'editor', monitorLimit: 10 }),
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

  const batches = [], submissions = [];
  let healthy = false;
  let gate;
  let providerStatus = 204;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
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
            await gate?.hold;
          } else if (gate) {
            gate.done();
          }
          return new Response(null, { status: 204 });
        },
      },
      outboundService: async request => {
        assert.ok(['hooks.example', 'discord.com'].includes(new URL(request.url).hostname), 'redirects stay unfollowed');
        submissions.push({ url: request.url, payload: await request.json() });
        return new Response(providerStatus === 204 ? null : 'sensitive provider response', {
          status: providerStatus, headers: { Location: 'https://redirect.example/secret' },
        });
      },
    },
  ] }));
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
  async function until(condition) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the Queue consumer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
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
      await until(() => submissions.length === before + 2);
      const [first, second] = submissions.slice(before).sort((a, b) => a.url.localeCompare(b.url));
      assert.equal(first.url, discord + '/slack');
      assert.equal(second.url, slack);
      for (const { payload } of [first, second]) {
        assert.match(payload.text, /Incident recovered/);
        assert.ok(payload.text.includes(new Date(recoveredAt).toISOString()));
        assert.doesNotMatch(payload.text, /@everyone|<!channel>|<@&123>|internal\.example|8443|target-secret/);
      }
      assert.doesNotMatch(JSON.stringify(batches), /internal\.example|8443|target-secret|hooks\.example|\/token/);

      // Hold the batch before the real trigger checks eligibility.
      let release;
      let complete;
      const done = new Promise(resolve => { complete = resolve; });
      gate = { hold: new Promise(resolve => { release = resolve; }), done: complete };
      const priorBatches = batches.length;
      healthy = false;
      providerStatus = 302;
      await tick(host);
      try {
        await until(() => batches.length > priorBatches);
        const committed = (await json(host, '/api/operator')).incidents;
        assert.equal(committed.filter(incident => incident.closedAt === null).length, 1);
        await json(host, monitorPath, 'PATCH', { destinationIds: [ids[1]] });
        await json(host, monitorPath, 'PATCH', { destinationIds: ids });
      } finally { release(); }
      await Promise.race([done, until(() => !gate)]);
      gate = undefined;
      assert.deepEqual(submissions.slice(before + 2).map(item => item.url), [discord + '/slack']);
      await json(host, monitorPath, 'DELETE');
    }
    console.log('PASS Incident fan-out, opt-in, trusted two-Worker Queue delivery, safe content, stale selection cancellation and no redirects');
  } finally {
    await mf.dispose();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
