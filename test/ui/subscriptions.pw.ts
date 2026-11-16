// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('live public changes preserve theme, history focus and node identity without navigation', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const created = await request.post('/api/operator/monitors', { headers, data: { name: 'Live producer', kind: 'heartbeat' } });
  const id = (await created.json()).monitors.at(-1).id;
  try {
    const connected = page.waitForEvent('websocket', socket => socket.url().endsWith('/api/status/subscribe'));
    await page.goto('/'); await connected;
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
    const row = page.locator('#public-monitors > article').filter({ has: page.getByRole('heading', { name: 'Live producer', exact: true }) });
    const history = row.locator('.history-day').last();
    await history.focus(); await history.press('Enter');
    const originalRow = await row.elementHandle(); const originalDay = await history.elementHandle();
    let navigations = 0; page.on('framenavigated', () => { navigations++; });
    await request.post('/heartbeat/' + id, { headers });
    await expect(row.locator('.status')).toHaveText('Operational');
    expect(await originalRow!.evaluate(node => node.isConnected)).toBe(true);
    expect(await originalDay!.evaluate(node => node === document.activeElement)).toBe(true);
    await expect(history).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#stale')).toBeHidden(); expect(navigations).toBe(0);
  } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
});
