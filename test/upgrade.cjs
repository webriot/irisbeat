// SPDX-License-Identifier: AGPL-3.0-only
// Manual upgrade regression: uses the foundation commit from local Git history.
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const assert = require('node:assert/strict');
const project = process.cwd();
// Use the runtime/bundler shipped with the installed Cloudflare test plugin.
const localRequire = createRequire(join(project, 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');
const legacyNotificationRevision = '70ba924ee9a2b15a3d6b6cc49abc8039aedb7f70';
const liveViews = process.argv.includes('--live-views');
const statusPublication = process.argv.includes('--status-publication');
const analyticsUpgrade = process.argv.includes('--analytics');
const base = (statusPublication ? 'c4fcfa3a2eeac1f8ee18cb962c499c3d81f2d59a' : liveViews || analyticsUpgrade ? '4f9442a0e660907b02c00c942e05ed4e43abab3c' : process.argv.includes('--notifications') ? legacyNotificationRevision : process.argv[2]) || '6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3';
const tcp = process.argv[3] === 'tcp';
const temporary = mkdtempSync(join(tmpdir(), 'irisbeat-upgrade-'));
(async () => {
  const sources = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'src'], { encoding: 'utf8' }).trim().split('\n');
  for (const source of sources) {
    const destination = join(temporary, source.slice(4));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, execFileSync('git', ['show', `${base}:${source}`]));
  }
  const wrapper = index => {
    const source = JSON.stringify(index);
    const publicationFixture = statusPublication && index.startsWith(project);
    const current = index.startsWith(project);
    const analyticsFixture = current ? `import { availabilityFixture } from './test/availability-fixture.ts';` : '';
    const analyticsConstructor = `constructor(ctx, env) {
      const analytics = availabilityFixture(ctx.storage);
      const bindings = { ...analytics.bindings };
      if (env.TEST_AVAILABILITY === 'no-write') delete bindings.AVAILABILITY_HISTORY;
      if (env.TEST_AVAILABILITY === 'no-query') delete bindings.AVAILABILITY_QUERY;
      super(ctx, { ...env, ...bindings });
      this.testAnalytics = analytics;
    }`;
    const bindings = publicationFixture
      ? `import { createHostedWorker, MonitoringContext as EngineContext, NotificationDelivery } from ${source};
        export { NotificationDelivery };
        export class MonitoringContext extends EngineContext {
          ${analyticsConstructor}
          testHistoryMode(mode) { this.testAnalytics.setMode(mode); }
          testHistoryQueries() { return this.testAnalytics.queries; }
          testAlarmAt() { return this.ctx.storage.getAlarm(); }
          testPublished() { return this.ctx.storage.kv.get("test-publication") ?? null; }
          onStatusPublished(hint) {
            const partials = hint.scopes.map(scope => [scope, JSON.parse(this.readPublishedStatus(scope, hint.revision).body)]);
            this.ctx.storage.kv.put("test-publication", { hint, partials });
            super.onStatusPublished(hint);
          }
        }
        const hosted = createHostedWorker({
          contractVersion: "1",
          resolve(request) {
            const id = request.headers.get("x-test-tenant");
            return id && { id, monitorLimit: 10, permission: request.headers.has("Authorization") ? "editor" : null };
          },
          contexts: () => [],
        });`
      : current ? `import { MonitoringContext as EngineContext } from ${source};
        export { NotificationDelivery } from ${source};
        export class MonitoringContext extends EngineContext { ${analyticsConstructor} }`
      : `export { MonitoringContext } from ${source};`;
    return `import app from ${source}; ${analyticsFixture} ${bindings}
      export default { async fetch(request, env, ctx) {
        const url = new URL(request.url);
        ${publicationFixture ? `if (url.pathname === '/test-status-alarm') {
          return Response.json(await env.MONITORING.getByName('personal').testAlarmAt());
        }
        if (url.pathname === '/test-history-mode') {
          await env.MONITORING.getByName('personal').testHistoryMode(url.searchParams.get('mode'));
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/test-history-queries') {
          return Response.json(await env.MONITORING.getByName('personal').testHistoryQueries());
        }
        if (url.pathname === '/test-status-published') {
          return Response.json(await env.MONITORING.getByName('personal').testPublished());
        }` : ''}
        const scheduledAt = url.pathname === '/test-tick' ? url.searchParams.get('at') : null;
        const testAt = request.headers.get('x-test-at') ?? scheduledAt;
        const now = Date.now;
        if (testAt) Date.now = () => Number(testAt);
        try {
          if (scheduledAt !== null) {
            await app.scheduled({ scheduledTime: Number(scheduledAt) }, env, ctx);
            return new Response('checked');
          }
          return await ${publicationFixture ? "(url.hostname === 'tenants.example' ? hosted : app)" : "app"}.fetch(request, env, ctx); }
        finally { Date.now = now; }
      } };`;
  };
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
    nodePaths: [join(project, 'node_modules')],
    bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', ...(tcp ? [] : ['cloudflare:sockets'])],
    plugins: tcp ? [socketTarget] : [],
  })).outputFiles[0].text;
  let outcome = 503;
  let attempts = 0;
  const deliveries = [];
  const destination = 'https://hooks.example/upgrade';
  const recordWebhook = async request => {
    deliveries.push({ url: request.url, body: await request.json() });
    return new Response(null, { status: 204 });
  };
  const delivery = (await build({
    entryPoints: ['src/notification-delivery.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['cloudflare:workers'],
  })).outputFiles[0].text;
  function options(script, stateDirectory = 'state', withQueue = false, port, vars = {}) {
    const monitoring = {
      name: 'irisbeat', modules: true, script, compatibilityDate: '2026-11-13',
      bindings: { INSTALLATION_SECRET: 'upgrade-test-secret', ...(!statusPublication ? { STATUS_RENDER_INTERVAL_SECONDS: liveViews ? '1' : '0' } : {}), ...vars },
      durableObjects: { MONITORING: { className: 'MonitoringContext', useSQLite: true } },
      ...(withQueue ? { queueProducers: { NOTIFICATION_QUEUE: 'upgrade-notifications' } } : {}),
      outboundService: request => {
        if (request.method === 'POST') return recordWebhook(request);
        attempts++;
        return new Response(null, { status: outcome });
      },
    };
    return convertV4MiniflareOptions({
      durableObjectsPersist: join(temporary, stateDirectory), ...(port ? { port } : {}), workers: [monitoring, ...(statusPublication && withQueue ? [{
        name: 'status-edge', modules: true, script, compatibilityDate: monitoring.compatibilityDate,
        bindings: monitoring.bindings,
        durableObjects: { MONITORING: { className: 'MonitoringContext', scriptName: 'irisbeat' } },
      }] : []), ...(withQueue ? [{
        name: 'delivery', modules: true, script: delivery, compatibilityDate: '2026-11-18',
        queueConsumers: { 'upgrade-notifications': { maxBatchTimeout: 0.1, maxRetries: 10 } },
        queueProducers: { NOTIFICATION_HANDOFF: 'upgrade-notifications', NOTIFICATION_DLQ: 'upgrade-dlq' },
        durableObjects: { NOTIFICATION_RECOVERY: { className: 'NotificationRecovery', useSQLite: true } },
        serviceBindings: { NOTIFICATION_DELIVERY: { name: 'irisbeat', entrypoint: 'NotificationDelivery' } },
        outboundService: recordWebhook,
      }] : [])],
    });
  }
  let mf = new Miniflare(options(await bundle(join(temporary,'index.ts'))));
  const request = (path, method='GET', body, at) => mf.dispatchFetch('https://irisbeat.example'+path,{method,headers:{authorization:'Bearer upgrade-test-secret','content-type':'application/json',...(at === undefined ? {} : {'x-test-at':String(at)})},...(body?{body:JSON.stringify(body)}:{})});
  const tick = at => request('/test-tick?at='+at);
  const start = Date.UTC(2026,10,13);
  try {
    if (statusPublication) {
      const test = require('./status-publication.cjs');
      const application = await bundle(join(project, 'src/index.ts'));
      await test({ mf, options, application, request, tick, deliveries, fresh: options => new Miniflare(options) });
      return;
    }
    if (liveViews) {
      const { chromium } = require('@playwright/test');
      const browser = await chromium.launch();
      try {
        await request('/api/operator', 'PUT', { pageName: 'Before upgrade' });
        const { monitor } = await (await request('/api/operator/monitors', 'POST', { name: 'Retained Heartbeat', kind: 'heartbeat' })).json();
        await request('/heartbeat/' + monitor.id, 'POST');
        const previous = await browser.newPage();
        const url = (await mf.ready).href;
        await Promise.all([
          previous.waitForEvent('websocket', socket => socket.url().endsWith('/api/status/events')),
          previous.goto(url),
        ]);
        assert.equal(await previous.title(), 'Before upgrade');
        assert.equal(await previous.locator('.percentage').textContent(), '100.00%');

        async function signIn(page) {
          await page.goto(new URL('/operator', url).href);
          await page.getByLabel('Installation secret', { exact: true }).fill('upgrade-test-secret');
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await page.locator('#editor').waitFor({ state: 'visible' });
        }
        const previousOperator = await browser.newPage();
        const oldOperatorSocket = previousOperator.waitForEvent('websocket', socket => socket.url().endsWith('/api/operator/events'));
        await signIn(previousOperator);
        await oldOperatorSocket;
        const edit = previousOperator.getByRole('button', { name: 'Edit Retained Heartbeat', exact: true });
        await edit.focus();
        await previousOperator.keyboard.press('Enter');
        await previousOperator.getByLabel('Monitor name', { exact: true }).fill('Unsaved draft');
        await previousOperator.getByRole('button', { name: 'Settings', exact: true }).click();
        assert.equal(await previousOperator.getByLabel('Page name').inputValue(), 'Before upgrade');

        await mf.setOptions(options(await bundle(join(project, 'src/index.ts')), 'state', false, Number(new URL(url).port)));
        const legacyUpgrade = await mf.dispatchFetch('https://irisbeat.example/api/status/events', {
          headers: { Upgrade: 'websocket', Origin: 'https://irisbeat.example' },
        });
        assert.equal(legacyUpgrade.status, 404);
        const next = await browser.newPage();
        await Promise.all([
          next.waitForEvent('websocket', socket => socket.url().endsWith('/api/status/events/v2')),
          next.goto((await mf.ready).href),
        ]);
        await next.locator('#updates-mode').waitFor({ state: 'hidden' });
        await next.getByRole('heading', { name: 'Retained Heartbeat' }).waitFor();
        assert.equal(await next.locator('.percentage').textContent(), 'No observations');
        const nextOperator = await browser.newPage();
        const authorized = nextOperator.waitForEvent('websocket', socket => socket.url().endsWith('/api/operator/events/v2'))
          .then(socket => socket.waitForEvent('framereceived', frame => frame.payload === 'authorized'));
        await signIn(nextOperator);
        await authorized;
        await nextOperator.getByRole('button', { name: 'Settings', exact: true }).click();
        assert.equal(await nextOperator.getByLabel('Page name').inputValue(), 'Before upgrade');

        const partial = next.waitForResponse(response => response.url().includes('/api/status/partials/page?revision=1'));
        const operatorPartial = nextOperator.waitForResponse(response => response.url().includes('/api/operator/partials/page?revision=1'));
        const legacyWrite = previousOperator.waitForResponse(response => response.url().endsWith('/api/operator') && response.request().method() === 'PUT');
        await previousOperator.getByLabel('Page name').fill('After upgrade');
        await previousOperator.getByRole('button', { name: 'Save page', exact: true }).click();
        const legacyData = await (await legacyWrite).json();
        assert.equal(legacyData.pageName, 'After upgrade');
        assert.equal(legacyData.monitors[0].id, monitor.id);
        assert.equal(legacyData.monitors[0].history.percentage, null);
        assert.deepEqual(await (await operatorPartial).json(), {
          revision: 1, html: '<h1>After upgrade</h1>', pageName: 'After upgrade', permission: 'editor',
        });
        await nextOperator.waitForFunction(() => document.querySelector('#pageName').value === 'After upgrade');
        await previousOperator.getByRole('button', { name: 'Monitors', exact: true }).click();
        assert.equal(await previousOperator.getByLabel('Monitor name', { exact: true }).inputValue(), 'Unsaved draft');
        assert.deepEqual(await (await partial).json(), { revision: 1, html: '<h1>After upgrade</h1>' });
        await next.getByRole('heading', { name: 'After upgrade' }).waitFor();
        const row = next.waitForResponse(response => response.url().includes('/api/status/partials/monitor/' + monitor.id + '?revision=2'));
        assert.equal((await request('/heartbeat/' + monitor.id, 'POST')).status, 204);
        assert.match((await (await row).json()).html, /100\.00%/);
        await next.getByText('100.00%').waitFor();
        await previous.bringToFront();
        await previous.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await previous.getByRole('heading', { name: 'After upgrade' }).waitFor();
        console.log('PASS: legacy Status and Operator recover through HTTP and new tabs receive scoped revisions over preserved Monitor state');
      } finally { await browser.close(); }
      return;
    }
    if (analyticsUpgrade) {
      const read = at => request('/api/operator', 'GET', undefined, at).then(response => response.json());
      assert.equal((await request('/api/operator/monitors', 'POST', {
        name: 'Existing HTTP', url: 'https://target.example/health', failureThreshold: 1, recoveryThreshold: 2,
      }, start)).status, 201);
      await tick(start);
      outcome = 204;
      await tick(start + 60_000);
      const before = await read(start + 60_000);
      assert.equal(before.monitor.history.percentage, 50);
      assert.equal(before.monitor.state, 'down');
      const maintenance = await request('/api/operator/monitors', 'POST', { name: 'Private', kind: 'heartbeat', published: false }, start).then(response => response.json());
      const privateId = maintenance.monitors[1].id;
      assert.equal((await request('/api/operator/monitors/' + privateId + '/maintenance', 'PUT', {
        endsAt: start + 360_000,
      }, start + 60_000)).status, 200);
      const beforeUpgrade = await read(start + 60_000);
      const upgraded = await bundle(join(project, 'src/index.ts'));
      const legacy = await bundle(join(temporary, 'index.ts'));
      for (const missing of ['no-write', 'no-query']) {
        await mf.setOptions(options(upgraded, 'state', false, undefined, { TEST_AVAILABILITY: missing }));
        const readiness = await request('/api/operator/history/readiness', 'GET', undefined, start + 60_000);
        assert.equal(readiness.status, 503);
        assert.deepEqual(await readiness.json(), { ready: false, reason: 'configuration_missing' });
        assert.equal((await read(start + 60_000)).monitor.history, null);
        await mf.setOptions(options(legacy));
        assert.equal((await read(start + 60_000)).monitor.history.percentage, 50);
      }
      await mf.setOptions(options(upgraded));
      const after = await read(start + 60_000);
      const { history: oldHistory, ...oldMonitor } = beforeUpgrade.monitor;
      const { history: newHistory, ...newMonitor } = after.monitor;
      assert.equal(oldHistory.percentage, 50);
      assert.deepEqual(newMonitor, { ...oldMonitor, effectiveIntervalSeconds: 60 });
      assert.deepEqual(after.incidents, beforeUpgrade.incidents);
      assert.deepEqual(after.monitors[1].maintenance, beforeUpgrade.monitors[1].maintenance);
      assert.equal(after.monitors[1].published, false);
      assert.equal(newHistory.days.length, 90);
      assert.ok(newHistory.days.every(day => day.state === 'empty'));
      assert.equal(newHistory.percentage, null);
      await tick(start + 120_000);
      const recovered = await read(start + 120_000);
      assert.equal(recovered.monitor.state, 'up');
      assert.equal(recovered.incidents[0].id, beforeUpgrade.incidents[0].id);
      assert.equal(recovered.incidents[0].closedAt, start + 120_000);
      assert.equal(recovered.monitor.history.days.at(-1).successes, 1);
      assert.equal(recovered.monitor.history.percentage, 100);
      console.log('PASS: Irisbeat 0.3.0 -> current resets only availability history and records the first Analytics Engine observation');
      return;
    }
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
      assert.deepEqual(after.destinations.map(({ url }) => url), [destination]);
      assert.deepEqual(after.monitors[0].destinationIds, []);
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
      assert.deepEqual(deliveries,[{url:destination,body:{text:'Legacy producer: Incident opened'}}]);
      assert.equal((await request('/api/operator/monitors','POST',{name:'New producer',kind:'heartbeat'},start+440000)).status,201);
      const mixed = await (await request('/api/operator')).json();
      assert.notEqual(mixed.monitors[1].id,'website');
      assert.equal(mixed.monitors[1].lastSeen,null);
      await tick(start+619999);
      assert.equal((await (await request('/api/operator')).json()).monitors[1].state,'unknown');
      await tick(start+620000);
      assert.equal((await (await request('/api/operator')).json()).monitors[1].state,'down');
      assert.equal(attempts,0);
      // Enable Calendar on the migrated identity without inventing earlier occurrences.
      const legacyIncident = (await (await request('/api/operator')).json()).incidents.find(row => row.monitorId === 'website' && row.closedAt === null);
      assert.ok(legacyIncident);
      assert.equal((await request('/api/operator/monitors/website', 'PATCH', { scheduleMode: 'calendar', cron: '*/5 * * * *' }, start + 650000)).status, 200);
      const beforeCalendar = (await (await request('/api/operator', 'GET', undefined, start + 650000)).json()).monitors[0];
      assert.equal(beforeCalendar.graceSeconds, 30);
      await tick(start + 899999);
      assert.deepEqual((await (await request('/api/operator')).json()).monitors[0].lastResult, beforeCalendar.lastResult);
      for (const occurrence of [900000, 1200000, 1500000]) {
        await request('/heartbeat/website', 'POST', undefined, start + occurrence + 30000);
        await mf.setOptions(options((await bundle(join(project, 'src/index.ts'))) + '\n// Calendar receipt restart ' + occurrence));
        await tick(start + occurrence + 30001);
      }
      const calendarRecovered = await (await request('/api/operator')).json();
      assert.equal(calendarRecovered.monitors[0].id, 'website');
      assert.equal(calendarRecovered.incidents.find(row => row.id === legacyIncident.id).closedAt, start + 1530000);
      assert.equal(calendarRecovered.monitors[0].scheduleMode, 'calendar');
      console.log('PASS: migrated Heartbeat enables Calendar prospectively and retains identity, Incident, thresholds and persisted receipt evidence');
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
    await mf.setOptions(options(await bundle(join(project,'src/index.ts')), 'state', supportsWebhook));
    const after = await (await request('/api/operator', 'GET', undefined, start + 120000)).json();
    if (supportsWebhook) {
      assert.equal(after.webhookUrl,destination);
      assert.deepEqual(after.destinations.map(({ url }) => url), [destination]);
      assert.deepEqual(after.monitors[0].destinationIds, []);
    }
    assert.equal(after.pageName,'Old page');
    assert.equal(after.monitors[0].id,before.monitor.id);
    assert.equal(after.monitors[0].published,true);
    if (tcp) { assert.equal(after.monitors[0].kind,'tcp'); assert.equal(after.monitors[0].hostname,'db.example'); assert.equal(after.monitors[0].port,5432); }
    else { assert.equal(after.monitors[0].kind,'http'); assert.equal(after.monitors[0].url,'https://target.example/health'); }
    assert.equal(after.monitors[0].state,'down');
    assert.equal(after.monitors[0].intervalSeconds,60);
    assert.equal(after.monitors[0].scheduleMode,'interval');
    assert.equal(after.monitors[0].timeoutSeconds,beforeTiming.monitor.timeoutSeconds ?? 10);
    assert.equal(after.monitors[0].failureThreshold,2);
    assert.equal(after.monitors[0].recoveryThreshold,2);
    assert.equal(after.incidents[0].id,before.incidents[0].id);
    assert.equal(after.incidents[0].monitorName,'Legacy service');
    assert.equal(after.incidents[0].closedAt,null);
    assert.deepEqual(after.monitors[0].lastResult,{at:start+120000,outcome:'success'});
    assert.equal(after.monitors[0].history.days.length, 90);
    assert.equal(after.monitors[0].history.percentage, null, 'the Analytics Engine cutover starts with empty bars');
    assert.ok(after.monitors[0].history.days.every(day => day.state === 'empty'));
    await tick(start+120000); assert.equal(attempts,3);
    await tick(start+180000);
    const recovered = await (await request('/api/status')).json();
    if (supportsWebhook) assert.deepEqual(deliveries,[
      {url:destination,body:{text:'Legacy service: Incident opened'}},
    ]);
    assert.equal(recovered.monitors[0].state,'up');
    assert.equal(recovered.incidents[0].closedAt,start+180000);
    if (supportsWebhook) {
      const monitorPath = '/api/operator/monitors/' + before.monitor.id;
      assert.equal((await request(monitorPath, 'PATCH', { destinationIds: [after.destinations[0].id] })).status, 200);
      assert.equal(deliveries.length, 1, 'selecting the migrated webhook does not replay earlier events');
      outcome = 503;
      await tick(start + 240_000);
      await tick(start + 300_000);
      const deadline = Date.now() + 5000;
      while ((await (await request('/api/operator')).json()).destinations[0].latestSubmission?.status !== 'accepted') {
        assert.ok(Date.now() < deadline, 'timed out waiting for the upgraded Queue consumer');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(deliveries.length, 2, 'one new Incident results in exactly one additional webhook');
      assert.equal(deliveries[1].url, destination);
      assert.match(deliveries[1].body.text, /Incident opened/);
      assert.ok(deliveries[1].body.text.includes(new Date(start + 300_000).toISOString()));
    }
    assert.equal((await request('/api/operator/monitors/' + before.monitor.id,'DELETE')).status,200);
    assert.equal((await (await request('/api/status')).json()).incidents.length,0);
    assert.equal((await (await request('/api/operator')).json()).incidents[0].monitorName,'Legacy service');
    if (supportsWebhook) {
      await mf.dispose();
      mf = new Miniflare(options(await bundle(join(temporary,'index.ts')), 'webhook-only'));
      assert.equal((await request('/api/operator/webhook','PUT',{url:destination})).status,200);
      await mf.setOptions(options(await bundle(join(project,'src/index.ts')), 'webhook-only'));
      const upgraded = await (await request('/api/operator')).json();
      assert.deepEqual(upgraded.destinations.map(({ url }) => url), [destination]);
      assert.deepEqual(upgraded.monitors, []);
      assert.equal(upgraded.webhookUrl, destination);
      assert.equal((await request('/api/operator','PUT',{pageName:'New page'})).status,200);
      assert.equal((await request('/api/operator/monitors','POST',{name:'New service',url:'https://target.example/health'})).status,201);
      assert.equal((await (await request('/api/operator')).json()).webhookUrl,destination);
    }
    console.log(`PASS: ${base} (${tcp ? 'TCP' : 'HTTP'}) -> current; webhook preservation and explicit opt-in ${supportsWebhook ? 'verified' : 'not supported by old bundle'}`);
    console.log('PASS: real legacy Worker -> current Worker preserves identity, page, target, due time, open Incident, recovery streak, publication and retained deleted history');
  } finally { await mf.dispose(); rmSync(temporary,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
