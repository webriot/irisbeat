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
      await expect(page.getByRole('heading', { name, level: 2, exact: true })).toBeVisible();
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

test('ledger keeps four aligned actions and Maintenance owns its lifecycle', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const names = ['Ledger short ' + Date.now(), 'Ledger ' + 'long Monitor name '.repeat(6)];
  const ids: string[] = [];
  for (const name of names) {
    const data = await (await request.post('/api/operator/monitors', { headers, data: { name, kind: 'heartbeat', published: ids.length === 0 } })).json();
    ids.push(data.monitors.at(-1).id);
  }
  try {
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const rows = ids.map(id => page.locator('tr[data-key="' + id + '"]'));
    for (const row of rows) await expect(row.getByRole('button')).toHaveCount(4);
    expect(await rows[0].getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Edit ' + names[0], 'Unpublish ' + names[0], 'Maintenance ' + names[0], 'Delete ' + names[0]]);
    const navigation = page.locator('#operator-navigation');
    const bounds = await navigation.boundingBox();
    const tableBounds = await page.getByRole('table', { name: 'Monitors', exact: true }).boundingBox();
    expect(bounds!.x + bounds!.width).toBe(tableBounds!.x + tableBounds!.width);
    expect(await navigation.getByRole('button').evaluateAll(buttons => buttons.filter(button => button.getClientRects().length > 0).map(button => button.getBoundingClientRect().height))).toEqual([40, 40]);
    const headersX = await page.locator('thead th').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().x));
    for (const row of rows) expect(await row.locator('td').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().x))).toEqual(headersX);
    const maintenance = rows[0].getByRole('button', { name: 'Maintenance ' + names[0], exact: true });
    await maintenance.focus();
    await expect(maintenance.locator('.action-label')).toBeVisible();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Maintenance', exact: true });
    await expect(dialog).toBeVisible();
    const end = dialog.getByLabel(/End time \(.+\)/);
    await expect(end).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(end).toBeFocused();
    const initial = await end.inputValue();
    await dialog.getByRole('button', { name: 'Start Maintenance', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(rows[0].getByRole('button')).toHaveCount(4);
    expect(await rows[0].locator('td').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().x))).toEqual(headersX);
    await expect(maintenance).toBeFocused();
    await maintenance.click();
    await expect(end).toHaveValue(initial);
    await end.fill('2090-01-02T12:00');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(maintenance).toBeFocused();
    await maintenance.click();
    await expect(end).toHaveValue(initial);
    await end.fill('2090-01-03T12:00');
    await dialog.getByRole('button', { name: 'Update end date', exact: true }).click();
    await expect(dialog).toBeHidden();
    await maintenance.click();
    await expect(end).toHaveValue('2090-01-03T12:00');
    await page.route('**/api/operator/monitors/*/maintenance', route => route.fulfill({ status: 400, json: { error: 'End time rejected' } }));
    await end.fill('2090-01-04T12:00');
    await dialog.getByRole('button', { name: 'Update end date', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('End time rejected');
    await expect(end).toHaveValue('2090-01-04T12:00');
    await page.unroute('**/api/operator/monitors/*/maintenance');
    await page.keyboard.press('Escape');
    await expect(maintenance).toBeFocused();
    await maintenance.click();
    await dialog.getByRole('button', { name: 'End Maintenance', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(rows[0]).toContainText('Awaiting check');
    await page.screenshot({ path: '.tmp/ledger-desktop.png', fullPage: true });
    for (const theme of ['Light', 'Dark', 'System']) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption({ label: theme });
      await page.setViewportSize({ width: 320, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const row of rows) {
        await expect(row.getByRole('button')).toHaveCount(4);
        for (const button of await row.getByRole('button').all()) {
          const box = await button.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await page.screenshot({ path: '.tmp/ledger-mobile-' + theme + '.png', fullPage: true });
    }
  } finally { for (const id of ids) await request.delete('/api/operator/monitors/' + id, { headers }); }
});
