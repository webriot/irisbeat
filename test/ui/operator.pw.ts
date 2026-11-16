// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('operator navigates Settings independently and edits inline through keyboard actions', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const response = await request.post('/api/operator/monitors', { headers, data: { name: 'Inline Monitor', url: 'https://example.invalid', published: false } });
  const id = (await response.json()).monitors.at(-1).id;
  try {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New Monitor', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('table', { name: 'Monitors', exact: true })).toBeHidden();
    await page.getByLabel('Page name', { exact: true }).fill('Independent page');
    await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('http://invalid.example');
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Saved');
    await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('http://invalid.example');
    await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
    await expect(page.locator('#message')).not.toHaveText('Saved');
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    const menu = page.getByLabel('Actions Inline Monitor', { exact: true });
    await menu.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Edit Inline Monitor', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Monitor name', { exact: true })).toBeFocused();
    await expect(page.locator('#configuration').locator('..')).toHaveAttribute('aria-label', 'Inline Monitor availability');
    await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://user:password@example.invalid');
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    await expect(page.locator('#message')).not.toHaveText('Saved');
    await expect(page.locator('#configuration')).toBeVisible();
    await expect(page.getByLabel('HTTP(S) target', { exact: true })).toHaveValue('https://user:password@example.invalid');
    await page.getByLabel('Monitor name', { exact: true }).fill('Cancelled name');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(menu).toBeFocused();
    await menu.click();
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('Incident history is retained'); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Delete Inline Monitor', exact: true }).click();
    await expect(menu).toBeFocused();
    expect((await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === id).name).toBe('Inline Monitor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
});

test.describe('touch actions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 900 } });
  test('touch opens the ellipsis menu and dismisses it on selection and outside tap', async ({ page, request }) => {
    const headers = { Authorization: 'Bearer ui-test-secret' };
    const response = await request.post('/api/operator/monitors', { headers, data: { name: 'Touch Monitor', kind: 'heartbeat' } });
    const id = (await response.json()).monitors.at(-1).id;
    try {
      await page.goto('/operator');
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).tap();
      const trigger = page.getByLabel('Actions Touch Monitor', { exact: true });
      await trigger.tap();
      await page.getByRole('heading', { name: 'Monitors', exact: true }).tap();
      await expect(page.getByRole('button', { name: 'Edit Touch Monitor', exact: true })).toBeHidden();
      await trigger.tap();
      await page.getByRole('button', { name: 'Edit Touch Monitor', exact: true }).tap();
      await expect(page.getByLabel('Monitor name', { exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Edit Touch Monitor', exact: true })).toBeHidden();
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await trigger.tap();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(page.getByRole('button', { name: 'Edit Touch Monitor', exact: true })).toBeHidden();
    } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
  });
});
