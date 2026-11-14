// SPDX-License-Identifier: AGPL-3.0-only
// Manual upgrade regression: uses the foundation commit from local Git history.
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const project = process.cwd();
// Use the runtime/bundler shipped with the installed Cloudflare test plugin.
const localRequire = createRequire(join(project, 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');
const base = process.argv[2] || '6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3';
const tcp = process.argv[3] === 'tcp';
const temporary = mkdtempSync(join(tmpdir(), 'irisbeat-upgrade-'));
(async () => {
  for (const file of ['index.ts', 'ui.ts']) writeFileSync(join(temporary, file), execFileSync('git', ['show', `${base}:src/${file}`]));
  const wrapper = index => `import app from ${JSON.stringify(index)}; export {MonitoringContext} from ${JSON.stringify(index)}; export default { async fetch(request, env, ctx) { const url = new URL(request.url); if(url.pathname === '/test-tick') { await app.scheduled({scheduledTime:Number(url.searchParams.get('at'))}, env, ctx); return new Response('checked'); } const testAt = request.headers.get('x-test-at'); const now = Date.now; if (testAt) Date.now = () => Number(testAt); try { return await app.fetch(request, env, ctx); } finally { Date.now = now; } } };`;
  const socketTarget = {
    name: 'substitute-tcp-target',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'test-target' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-target' }, () => ({
        contents: `export function connect(address) {
          return {
            opened: fetch('https://tcp-target.example/' + encodeURIComponent(address.hostname) + '/' + address.port)
              .then(response => { if (!response.ok) throw new Error('refused'); return {}; }),
            closed: Promise.resolve(), close: async () => {}
          };
        }`,
        loader: 'js',
      }));
    },
  };
  const bundle = async index => (await build({
    stdin: { contents: wrapper(index), resolveDir: project, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', ...(tcp ? [] : ['cloudflare:sockets'])],
    plugins: tcp ? [socketTarget] : [],
  })).outputFiles[0].text;
  let outcome = 503;
  let attempts = 0;
  const deliveries = [];
  const destination = 'https://hooks.example/upgrade';
  const options = (script, stateDirectory = 'state') => convertV4MiniflareOptions({ name:'irisbeat', modules:true, script, compatibilityDate:'2026-11-13', bindings:{INSTALLATION_SECRET:'upgrade-test-secret'}, durableObjects:{MONITORING:{className:'MonitoringContext',useSQLite:true}}, durableObjectsPersist:join(temporary,stateDirectory), outboundService:async request => { if (request.method === 'POST') { deliveries.push({ url: request.url, body: await request.json() }); return new Response(null, { status: 204 }); } attempts++; return new Response(null,{status:outcome}); } });
  let mf = new Miniflare(options(await bundle(join(temporary,'index.ts'))));
  const request = (path, method='GET', body, at) => mf.dispatchFetch('https://irisbeat.example'+path,{method,headers:{authorization:'Bearer upgrade-test-secret','content-type':'application/json',...(at === undefined ? {} : {'x-test-at':String(at)})},...(body?{body:JSON.stringify(body)}:{})});
  const tick = at => request('/test-tick?at='+at);
  const start = Date.UTC(2026,10,13);
  try {
    if (process.argv.includes('--heartbeat')) {
      assert.equal((await request('/api/operator/webhook','PUT',{url:destination})).status,200);
      assert.equal((await request('/api/operator','PUT',{pageName:'Old page',name:'Legacy producer',kind:'heartbeat',silenceSeconds:180,recoverySpacingSeconds:120,recoveryThreshold:3},start)).status,200);
      await tick(start+179999);
      assert.equal((await (await request('/api/status')).json()).incidents.length,0);
      await tick(start+180000);
      await request('/heartbeat/website','POST',undefined,start+200000);
      const before = await (await request('/api/operator')).json();
      assert.equal(before.monitor.state,'down');
      await mf.setOptions(options(await bundle(join(project,'src/index.ts'))));
      const after = await (await request('/api/operator')).json();
      assert.equal(after.pageName,'Old page');
      assert.equal(after.webhookUrl,destination);
      assert.equal(after.monitors[0].id,'website');
      assert.equal(after.monitors[0].kind,'heartbeat');
      assert.equal(after.monitors[0].published,true);
      assert.equal(after.monitors[0].lastSeen,start+200000);
      assert.equal(after.monitors[0].silenceSeconds,180);
      assert.equal(after.monitors[0].recoverySpacingSeconds,120);
      assert.equal(after.monitors[0].recoveryThreshold,3);
      assert.equal(after.incidents[0].id,before.incidents[0].id);
      assert.equal(after.incidents[0].monitorName,'Legacy producer');
      await request('/heartbeat/website','POST',undefined,start+319999);
      assert.equal((await (await request('/api/operator')).json()).monitor.state,'down');
      await request('/heartbeat/website','POST',undefined,start+320000);
      assert.equal((await (await request('/api/operator')).json()).monitor.state,'down');
      await request('/heartbeat/website','POST',undefined,start+440000);
      assert.equal((await (await request('/api/operator')).json()).incidents[0].closedAt,start+440000);
      assert.deepEqual(deliveries,[{url:destination,body:{text:'Legacy producer: Incident opened'}},{url:destination,body:{text:'Legacy producer: Incident recovered'}}]);
      assert.equal((await request('/api/operator/monitors','POST',{name:'New producer',kind:'heartbeat'},start+440000)).status,201);
      const mixed = await (await request('/api/operator')).json();
      assert.notEqual(mixed.monitors[1].id,'website');
      assert.equal(mixed.monitors[1].lastSeen,null);
      await tick(start+619999);
      assert.equal((await (await request('/api/operator')).json()).monitors[1].state,'unknown');
      await tick(start+620000);
      assert.equal((await (await request('/api/operator')).json()).monitors[1].state,'down');
      assert.equal(attempts,0);
      console.log(`PASS: ${base} -> current; heartbeat identity, creation anchor, freshness, recovery count/spacing, Incident and webhook retained`);
      return;
    }
    const webhookSave = await request('/api/operator/webhook','PUT',{url:destination});
    const supportsWebhook = webhookSave.status === 200;
    assert.ok(supportsWebhook || webhookSave.status === 404);
    assert.equal((await request('/api/operator','PUT',{pageName:'Old page',name:'Legacy service',...(tcp ? {kind:'tcp',hostname:'db.example',port:5432} : {url:'https://target.example/health'}),timeoutSeconds:7})).status,200);
    await tick(start); await tick(start+60000);
    const before = await (await request('/api/status')).json();
    assert.equal(before.monitor.state,'down');
    const beforeTiming = await (await request('/api/operator')).json();
    if (supportsWebhook) assert.equal(beforeTiming.webhookUrl,destination);
    // One recovery observation before replacing the actual Worker bundle.
    outcome = 204; await tick(start+120000);
    await mf.setOptions(options(await bundle(join(project,'src/index.ts'))));
    const after = await (await request('/api/operator', 'GET', undefined, start + 120000)).json();
    if (supportsWebhook) assert.equal(after.webhookUrl,destination);
    assert.equal(after.pageName,'Old page');
    assert.equal(after.monitors[0].id,before.monitor.id);
    assert.equal(after.monitors[0].published,true);
    if (tcp) { assert.equal(after.monitors[0].kind,'tcp'); assert.equal(after.monitors[0].hostname,'db.example'); assert.equal(after.monitors[0].port,5432); }
    else { assert.equal(after.monitors[0].kind,'http'); assert.equal(after.monitors[0].url,'https://target.example/health'); }
    assert.equal(after.monitors[0].state,'down');
    assert.equal(after.monitors[0].intervalSeconds,60);
    assert.equal(after.monitors[0].timeoutSeconds,beforeTiming.monitor.timeoutSeconds ?? 10);
    assert.equal(after.monitors[0].failureThreshold,2);
    assert.equal(after.monitors[0].recoveryThreshold,2);
    assert.equal(after.incidents[0].id,before.incidents[0].id);
    assert.equal(after.incidents[0].monitorName,'Legacy service');
    assert.equal(after.incidents[0].closedAt,null);
    assert.deepEqual(after.monitors[0].lastResult,{at:start+120000,outcome:'success'});
    assert.equal(after.monitors[0].history.days.length, 90);
    if (process.argv.includes('--history')) {
      assert.equal(after.monitors[0].history.days.at(-1).successes, 1);
      assert.equal(after.monitors[0].history.days.at(-1).failures, 2);
      assert.ok(Math.abs(after.monitors[0].history.percentage - 100 / 3) < 1e-10);
    } else if (base === '6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3') {
      assert.equal(after.monitors[0].history.percentage, null, 'lastResult must not fabricate earlier observations');
      assert.ok(after.monitors[0].history.days.every(day => day.state === 'empty'));
    }
    await tick(start+120000); assert.equal(attempts,3);
    await tick(start+180000);
    const recovered = await (await request('/api/status')).json();
    if (supportsWebhook) assert.deepEqual(deliveries,[
      {url:destination,body:{text:'Legacy service: Incident opened'}},
      {url:destination,body:{text:'Legacy service: Incident recovered'}},
    ]);
    assert.equal(recovered.monitors[0].state,'up');
    assert.equal(recovered.incidents[0].closedAt,start+180000);
    assert.equal((await request('/api/operator/monitors/' + before.monitor.id,'DELETE')).status,200);
    assert.equal((await (await request('/api/status')).json()).incidents.length,0);
    assert.equal((await (await request('/api/operator')).json()).incidents[0].monitorName,'Legacy service');
    if (supportsWebhook) {
      await mf.dispose();
      mf = new Miniflare(options(await bundle(join(temporary,'index.ts')), 'webhook-only'));
      assert.equal((await request('/api/operator/webhook','PUT',{url:destination})).status,200);
      await mf.setOptions(options(await bundle(join(project,'src/index.ts')), 'webhook-only'));
      assert.deepEqual(await (await request('/api/operator')).json(),{
        pageName:'Irisbeat', webhookUrl:destination, monitors:[], monitor:null, incidents:[],
      });
      assert.equal((await request('/api/operator','PUT',{pageName:'New page'})).status,200);
      assert.equal((await request('/api/operator/monitors','POST',{name:'New service',url:'https://target.example/health'})).status,201);
      assert.equal((await (await request('/api/operator')).json()).webhookUrl,destination);
    }
    console.log(`PASS: ${base} (${tcp ? 'TCP' : 'HTTP'}) -> current; webhook preservation/delivery ${supportsWebhook ? 'verified' : 'not supported by old bundle'}`);
    console.log('PASS: real legacy Worker -> current Worker preserves identity, page, target, due time, open Incident, recovery streak, publication and retained deleted history');
  } finally { await mf.dispose(); rmSync(temporary,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
