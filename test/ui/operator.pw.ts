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
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('http://invalid.example');
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Saved');
    await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('http://invalid.example');
    await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
    await expect(page.locator('#message')).not.toHaveText('Saved');
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    const editAction = page.getByRole('button', { name: 'Edit Inline Monitor', exact: true });
    await editAction.focus();
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
    await expect(editAction).toBeFocused();
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('Incident history is retained'); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Delete Inline Monitor', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete Inline Monitor', exact: true })).toBeFocused();
    expect((await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === id).name).toBe('Inline Monitor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
});

test.describe('touch actions', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 900 } });
  test('touch actions expose labels and open the editor', async ({ page, request }) => {
    const headers = { Authorization: 'Bearer ui-test-secret' };
    const response = await request.post('/api/operator/monitors', { headers, data: { name: 'Touch Monitor', kind: 'heartbeat' } });
    const id = (await response.json()).monitors.at(-1).id;
    try {
      await page.goto('/operator');
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).tap();
      const group = page.getByRole('group', { name: 'Actions Touch Monitor', exact: true });
      await expect(group.getByRole('button')).toHaveCount(4);
      for (const label of ['Edit', 'Unpublish', 'Maintenance', 'Delete']) await expect(group.getByText(label, { exact: true })).toBeVisible();
      const labels = await group.locator('.action-label').evaluateAll(labels => labels.map(label => { const rect = label.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height }; }));
      for (const label of labels) expect(label.height).toBeLessThanOrEqual(18);
      for (let i = 1; i < labels.length; i++) expect(labels[i].left).toBeGreaterThanOrEqual(labels[i - 1].right);
      await page.getByRole('button', { name: 'Edit Touch Monitor', exact: true }).tap();
      await expect(page.getByLabel('Monitor name', { exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await expect(page.getByRole('button', { name: 'Edit Touch Monitor', exact: true })).toBeFocused();
    } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
  });
});
