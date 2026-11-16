// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
test('subscribes before resync, coalesces notices and reconnects', async ({ page, request }) => {
  await request.put('/api/operator', { headers: { Authorization: 'Bearer ui-test-secret' }, data: { pageName: 'Initial socket page' } });
  let live!: import('@playwright/test').WebSocketRoute;
  let connections = 0;
  const acks: string[] = [];
  await page.routeWebSocket('**/api/status/events', socket => { live = socket; connections++; socket.onMessage(message => { acks.push(String(message)); }); });
  let name = 'After subscription';
  let reads = 0;
  let release: (() => void) | undefined;
  let held = false;
  await page.route('**/api/status', async route => {
    reads++;
    const pageName = name;
    if (held) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { pageName, paused: false, monitors: [], incidents: [] } });
  });
  await page.goto('/');
  await expect(page).toHaveTitle('After subscription');
  expect(reads).toBe(1);
  await page.clock.install();
  await page.clock.fastForward(180000);
  expect(reads).toBe(1);
  await page.clock.resume();
  held = true; live.send('changed');
  await expect.poll(() => !!release).toBe(true);
  for (let i = 0; i < 100; i++) live.send('changed');
  name = 'Coalesced latest'; held = false; release!();
  await expect(page).toHaveTitle('Coalesced latest');
  expect(reads).toBeLessThanOrEqual(3);
  await expect.poll(() => acks.length).toBeGreaterThan(0);
  name = 'Reconnect latest'; live.close();
  await expect(page.getByText('Polling', { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBe(2);
  await expect(page).toHaveTitle('Reconnect latest');
  await expect(page.getByText('Polling', { exact: true })).toBeHidden();
});

test('real public notifications preserve row identity, history selection and focus', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const saved = await (await request.post('/api/operator/monitors', { headers, data: { name: 'Socket producer', kind: 'heartbeat' } })).json();
  const monitor = saved.monitors.at(-1);
  const path = '/api/operator/monitors/' + monitor.id;
  try {
    await page.goto('/');
    await expect(page.getByText('Polling', { exact: true })).toBeHidden();
    const strip = page.locator('.history[data-monitor="' + monitor.id + '"]');
    const day = strip.locator('li').nth(88);
    await day.focus();
    const selected = await day.getAttribute('data-date');
    const node = await strip.elementHandle();
    await request.patch(path, { headers, data: { name: 'Live renamed producer' } });
    await expect(page.getByText('Live renamed producer', { exact: true })).toBeVisible();
    await expect(strip.locator('[aria-current="true"]')).toHaveAttribute('data-date', selected!);
    await expect(day).toBeFocused();
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  } finally { await request.delete(path, { headers }); }
});
test('failed reconnect attempts back off without postponing visible fallback polling', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const attempts: number[] = [];
    Object.assign(window, { socketAttempts: attempts });
    Object.defineProperty(window, 'WebSocket', { value: class {
      static OPEN = 1;
      constructor() { attempts.push(Date.now()); throw new Error('Connection unavailable'); }
    } });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  let reads = 0;
  await page.route('**/api/status', route => { reads++; return route.fulfill({ json: { pageName: 'Fallback works', paused: false, monitors: [], incidents: [] } }); });
  await page.goto('/');
  await page.clock.runFor(61000);
  await expect(page).toHaveTitle('Fallback works');
  expect(reads).toBe(1);
  const attempts = await page.evaluate(() => (window as unknown as { socketAttempts: number[] }).socketAttempts);
  expect(attempts.length).toBeGreaterThanOrEqual(5);
  const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
  expect(gaps[0]).toBeGreaterThanOrEqual(1000);
  expect(gaps[1]).toBeGreaterThanOrEqual(2000);
  expect(gaps[2]).toBeGreaterThanOrEqual(4000);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(30000);
  await expect(page.locator('#stale')).toBeHidden();
  await expect(page.getByText('Polling', { exact: true })).toBeVisible();
});
