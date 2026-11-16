// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

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
