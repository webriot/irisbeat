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
const base = '6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3';
const temporary = mkdtempSync(join(tmpdir(), 'irisbeat-upgrade-'));
(async () => {
  for (const file of ['index.ts', 'ui.ts']) writeFileSync(join(temporary, file), execFileSync('git', ['show', `${base}:src/${file}`]));
  const wrapper = index => `import app from ${JSON.stringify(index)}; export {MonitoringContext} from ${JSON.stringify(index)}; export default { async fetch(request, env, ctx) { const url = new URL(request.url); if(url.pathname === '/test-tick') { await app.scheduled({scheduledTime:Number(url.searchParams.get('at'))}, env, ctx); return new Response('checked'); } return app.fetch(request, env, ctx); } };`;
  const bundle = async index => (await build({stdin:{contents:wrapper(index), resolveDir:project, loader:'ts'}, bundle:true, write:false, format:'esm', platform:'neutral', external:['cloudflare:workers']})).outputFiles[0].text;
  let outcome = 503;
  let attempts = 0;
  const options = script => convertV4MiniflareOptions({ name:'irisbeat', modules:true, script, compatibilityDate:'2026-11-13', bindings:{INSTALLATION_SECRET:'upgrade-test-secret'}, durableObjects:{MONITORING:{className:'MonitoringContext',useSQLite:true}}, durableObjectsPersist:join(temporary,'state'), outboundService:() => { attempts++; return new Response(null,{status:outcome}); } });
  let mf = new Miniflare(options(await bundle(join(temporary,'index.ts'))));
  const request = (path, method='GET', body) => mf.dispatchFetch('https://irisbeat.example'+path,{method,headers:{authorization:'Bearer upgrade-test-secret','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const tick = at => request('/test-tick?at='+at);
  const start = Date.UTC(2026,10,13);
  try {
    assert.equal((await request('/api/operator','PUT',{pageName:'Old page',name:'Legacy service',url:'https://target.example/health'})).status,200);
    await tick(start); await tick(start+60000);
    const before = await (await request('/api/status')).json();
    assert.equal(before.monitor.state,'down');
    // One recovery observation before replacing the actual Worker bundle.
    outcome = 204; await tick(start+120000);
    await mf.setOptions(options(await bundle(join(project,'src/index.ts'))));
    const after = await (await request('/api/operator')).json();
    assert.equal(after.pageName,'Old page');
    assert.equal(after.monitors[0].id,'website');
    assert.equal(after.monitors[0].published,true);
    assert.equal(after.monitors[0].url,'https://target.example/health');
    assert.equal(after.monitors[0].state,'down');
    assert.equal(after.incidents[0].id,before.incidents[0].id);
    assert.equal(after.incidents[0].monitorName,'Legacy service');
    assert.equal(after.incidents[0].closedAt,null);
    await tick(start+120000); assert.equal(attempts,3);
    await tick(start+180000);
    const recovered = await (await request('/api/status')).json();
    assert.equal(recovered.monitors[0].state,'up');
    assert.equal(recovered.incidents[0].closedAt,start+180000);
    assert.equal((await request('/api/operator/monitors/website','DELETE')).status,200);
    assert.equal((await (await request('/api/status')).json()).incidents.length,0);
    assert.equal((await (await request('/api/operator')).json()).incidents[0].monitorName,'Legacy service');
    console.log('PASS: real foundation Worker -> current Worker preserves identity, page, target, due time, open Incident, recovery streak, publication and retained deleted history');
  } finally { await mf.dispose(); rmSync(temporary,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
