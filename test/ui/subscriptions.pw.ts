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

test('live operator changes and reconnect retain unsaved edits, focus, history, menus and theme; signout closes the socket', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const created = await request.post('/api/operator/monitors', { headers, data: { name: 'Live private', url: 'https://private.example', published: false } });
  const id = (await created.json()).monitors.at(-1).id;
  try {
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.assign(window, { testSockets: sockets });
      window.WebSocket = class extends NativeSocket { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); } };
    });
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    const connected = page.waitForEvent('websocket', socket => socket.url().includes('/api/operator/subscribe?ticket='));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const socket = await connected; expect(socket.url()).not.toContain('ui-test-secret');
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain('ui-test-secret');
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark');
    const row = page.locator('tr[data-monitor-id="' + id + '"]').filter({ has: page.locator('details.menu') });
    await row.locator('summary').click(); await page.getByRole('button', { name: 'Edit Live private', exact: true }).click();
    await page.locator('#name').fill('Unsaved name'); await page.locator('#url').fill('https://draft.example');
    await page.locator('#timeoutSeconds').fill('7');
    const history = page.locator('tr[data-monitor-id="' + id + '"] .history-day').last();
    await history.focus(); await history.press('Enter');
    await row.locator('summary').click();
    const originalRow = await row.elementHandle();
    await request.patch('/api/operator/monitors/' + id, { headers, data: { name: 'Remote rename' } });
    await expect(row).toContainText('Remote rename');
    await expect(row.locator('details')).toHaveAttribute('open', '');
    await expect(history).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#name').focus();
    const reconnected = page.waitForEvent('websocket', next => next !== socket && next.url().includes('/api/operator/subscribe?ticket='));
    await page.evaluate(() => { (window as unknown as { testSockets: WebSocket[] }).testSockets.at(-1)!.close(); });
    await reconnected;
    await request.patch('/api/operator/monitors/' + id, { headers, data: { name: 'After reconnect' } });
    await expect(row).toContainText('After reconnect');
    expect(await originalRow!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator('#name')).toHaveValue('Unsaved name'); await expect(page.locator('#name')).toBeFocused();
    await expect(page.locator('#url')).toHaveValue('https://draft.example'); await expect(page.locator('#timeoutSeconds')).toHaveValue('7');
    await expect(history).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#editor')).toBeHidden(); await expect(page.locator('#monitor-rows')).toBeEmpty();
    await expect.poll(() => page.evaluate(() => (window as unknown as { testSockets: WebSocket[] }).testSockets.every(socket => socket.readyState >= 2))).toBe(true);
  } finally { await request.delete('/api/operator/monitors/' + id, { headers }); }
});
