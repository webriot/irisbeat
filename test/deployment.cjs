// SPDX-License-Identifier: AGPL-3.0-only
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, symlinkSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { version } = require('../package.json');
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
    execFileSync(join(project, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--outdir', join(temporary, 'build')], { cwd: source, stdio: 'pipe' });
    const script = (await build({ stdin: { contents: `
      import worker from './src/index.ts';
      export { MonitoringContext } from './src/index.ts';
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
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-13',
      bindings: { INSTALLATION_SECRET: secret }, durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
      outboundService: async request => {
        const host = new URL(request.url).hostname;
        assert.ok(['http-target.example', 'tcp-target.example', 'webhook.example'].includes(host), 'all outbound destinations are substituted');
        if (host === 'webhook.example') { alerts.push(await request.json()); return new Response(null, { status: 204 }); }
        targets.push(host); return new Response(null, { status: outcome });
      },
    }));
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
    const monitors = (await status()).monitors;
    const heartbeat = '/heartbeat/' + monitors[2].id;
    assert.equal((await request(heartbeat, 'POST', undefined, 'wrong')).status, 401);
    assert.equal((await request(heartbeat, 'POST')).status, 204);
    const html = await (await request('/', 'GET', undefined, '')).text();
    assert.ok(html.includes('Personal acceptance'));
    assert.ok(html.includes('irisbeat-0.1.0-source.tar.gz'), 'network users can obtain Corresponding Source after publication');
    new (require('node:vm').Script)(await (await request('/operator.js')).text());
    for (const publicBody of [html, JSON.stringify(await status('/api/status'))]) {
      for (const privateValue of [secret, 'http-target.example', 'controlled.example', 'webhook.example']) assert.ok(!publicBody.includes(privateValue));
    }
    await tick(60_000); await tick(120_000); await tick(180_000);
    assert.equal(targets.filter(host => host === 'http-target.example').length, 3);
    assert.equal(targets.filter(host => host === 'tcp-target.example').length, 3);
    assert.equal((await status()).incidents.length, 3);
    assert.deepEqual(alerts.map(row => row.text).sort(), ['HTTP: Incident opened', 'Producer: Incident opened', 'TCP: Incident opened']);
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
    assert.equal(alerts.length, 6);
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
    console.log('PASS exact-source personal workerd smoke: dry-run entrypoint, secret guards, named anonymous ledger/source, HTTP/TCP/Heartbeat, Maintenance/history, opening/recovery webhooks, publication and retained Incidents; no live deployment');
  } finally {
    if (mf) await mf.dispose();
    rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
