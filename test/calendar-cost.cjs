// SPDX-License-Identifier: AGPL-3.0-only
// Manual cost measurement: node test/calendar-cost.cjs [git revision]
// Node reports active CPU for the synchronous algorithm. Local workerd reports
// host-observed wall time for the yielding validator, not production CPU limits.
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const localRequire = createRequire(join(process.cwd(), 'node_modules/@cloudflare/vitest-plugin/package.json'));
const { build, transform } = localRequire('esbuild');
const { Miniflare, convertV4MiniflareOptions } = localRequire('miniflare');

(async () => {
  const revision = process.argv[2];
  const source = revision
    ? execFileSync('git', ['show', revision + ':src/calendar.ts'], { encoding: 'utf8' })
    : readFileSync('src/calendar.ts', 'utf8');
  const js = (await transform(source, { loader: 'ts', format: 'esm' })).code;
  const { calendar } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const script = (await build({
    stdin: { contents: source + `
      export default { async fetch(request) {
        const { cron, zone, grace } = await request.json();
        let conversions = 0, chunk = 0, maxChunk = 0;
        const format = Intl.DateTimeFormat.prototype.formatToParts;
        Intl.DateTimeFormat.prototype.formatToParts = function(at) {
          conversions++; chunk++; return format.call(this, at);
        };
        const wait = scheduler.wait.bind(scheduler);
        scheduler.wait = async (...args) => {
          maxChunk = Math.max(maxChunk, chunk); chunk = 0; await wait(...args);
        };
        const parsed = calendar(cron, zone);
        const ok = await (parsed.acceptsGraceAsync ?? parsed.acceptsGrace)(grace, Date.UTC(2026, 10, 16));
        return Response.json({ ok, conversions, maxChunk: Math.max(maxChunk, chunk) });
      } };`, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral',
  })).outputFiles[0].text;
  for (const [cron, zone, grace] of [
    ['*/2 * * * *', 'America/New_York', 60],
    ['0-28/2,31-57/2 * * * *', 'Australia/Lord_Howe', 60],
    ['*/4 * * * *', 'Australia/Lord_Howe', 180],
  ]) {
    const cpu = process.cpuUsage();
    const nodeOK = calendar(cron, zone).acceptsGrace(grace, Date.UTC(2026, 10, 16));
    const used = process.cpuUsage(cpu);
    let maxBatchCpuMs = (used.user + used.system) / 1000;
    if (calendar(cron, zone).acceptsGraceAsync) {
      maxBatchCpuMs = 0;
      let batch = process.cpuUsage();
      const record = () => {
        const elapsed = process.cpuUsage(batch);
        maxBatchCpuMs = Math.max(maxBatchCpuMs, (elapsed.user + elapsed.system) / 1000);
      };
      // Node-only scheduler substitution measures active CPU between cooperative yields.
      globalThis.scheduler = { async wait() {
        record();
        await new Promise(setImmediate);
        batch = process.cpuUsage();
      } };
      await calendar(cron, zone).acceptsGraceAsync(grace, Date.UTC(2026, 10, 16));
      record();
      delete globalThis.scheduler;
    }
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-13' }));
    try {
      await mf.ready;
      const wall = performance.now();
      const response = await mf.dispatchFetch('https://test/', { method: 'POST', body: JSON.stringify({ cron, zone, grace }) });
      const result = await response.json();
      console.log(JSON.stringify({ revision: revision ?? 'working', cron, zone, grace, nodeOK,
        nodeCpuMs: (used.user + used.system) / 1000, maxBatchCpuMs, workerdWallMs: performance.now() - wall, ...result }));
    } finally {
      await mf.dispose();
    }
  }
})();
