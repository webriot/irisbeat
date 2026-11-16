// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

for (const scenario of [
  { state: 'empty', banner: 'No Monitors published' },
  { state: 'unknown', banner: 'Awaiting check' },
  { state: 'up', banner: 'All services operational' },
  { state: 'down', banner: 'Services unavailable' },
  { state: 'maintenance', banner: 'Maintenance' },
  { state: 'mixed', banner: 'Some services in Maintenance' },
  { state: 'paused', banner: 'Monitoring paused' },
]) {
  test(`initial and live ${scenario.state} ledgers preserve content, accessibility and escaping`, async ({ page, request }) => {
    const name = 'Monitor <img src=x onerror="window.ledgerInjected=true"> & "name"';
    const data = {
      pageName: 'Status <script>window.ledgerInjected=true</script> & "page"',
      paused: scenario.state === 'paused',
      monitors: scenario.state === 'empty' ? [] : [{
        id: 'monitor-"<&', name, kind: 'http',
        state: scenario.state === 'mixed' ? 'up' : scenario.state,
        history: { percentage: 50, days: [
          { date: '2026-11-15', state: 'degraded', successes: 1, failures: 1, maintenance: 1 },
          { date: '2026-11-16', state: 'empty', successes: 0, failures: 0, maintenance: 0 },
        ] },
      }, { id: 'other', name: 'Other Monitor', kind: 'heartbeat', state: 'maintenance', history: null }],
      incidents: scenario.state === 'down' ? [{ monitorId: 'monitor-"<&', openedAt: 1794700800000, closedAt: null }] :
        scenario.state === 'up' ? [{ monitorId: 'monitor-"<&', openedAt: 1794700800000, closedAt: 1794700860000 }] : [],
    };
    // Only the mixed case includes a second Monitor in a different state.
    if (scenario.state !== 'mixed') data.monitors = data.monitors.slice(0, 1);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('Use explicit snapshot reads'); } } });
    });
    let reads = 0;
    let snapshot = data;
    await page.route('**/api/status', route => { reads++; return route.fulfill({ json: snapshot }); });
    const rendered = await request.post('/__ui/status', { data });
    expect(rendered.ok()).toBe(true);
    const initial = await rendered.text();
    expect(initial).not.toContain('<script>window.ledgerInjected');
    expect(initial).not.toContain('<img src=x');
    if (data.incidents.length) expect(initial).toContain('>2026-11-15T00:00:00.000Z</time>');
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname === '/') return route.fulfill({ body: initial, contentType: 'text/html' });
      return route.fallback();
    });
    await page.goto('/');
    const ledger = page.locator('#public-status');
    await expect(page.getByRole('heading', { name: data.pageName, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: scenario.banner, exact: true })).toBeVisible();
    await expect(ledger.locator('script, img')).toHaveCount(0);
    if (data.monitors.length) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await ledger.locator('.history li').first().focus();
    }
    const before = await ledger.innerHTML();
    const row = data.monitors.length ? await ledger.locator('.ledger > article').first().elementHandle() : null;
    snapshot = { ...data, pageName: 'Live updated page' };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('heading', { name: 'Live updated page', exact: true })).toBeVisible();
    snapshot = data;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('heading', { name: data.pageName, exact: true })).toBeVisible();
    expect(reads).toBe(2);
    await expect(ledger).toHaveJSProperty('innerHTML', before);
    if (row) expect(await row.evaluate(element => element.isConnected)).toBe(true);
    if (data.monitors.length) await expect(ledger.locator('.history li').first()).toBeFocused();
  });
}
