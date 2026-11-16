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

test('real operator private notifications preserve unsaved drafts, focus, menus and history', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const saved = await (await request.post('/api/operator/monitors', { headers, data: { name: 'Operator socket', kind: 'heartbeat', published: false } })).json();
  const monitor = saved.monitors.at(-1); const path = '/api/operator/monitors/' + monitor.id;
  let connected = false;
  page.on('websocket', socket => { if (socket.url().endsWith('/api/operator/events')) socket.on('framereceived', frame => { if (frame.payload === 'authorized') connected = true; }); });
  try {
    await page.goto('/operator');
    await page.locator('#secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => connected).toBe(true);
    await page.getByLabel('Actions Operator socket', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit Operator socket', exact: true }).click();
    await page.locator('#name').fill('Unsaved socket draft');
    const draft = await page.locator('#configuration').elementHandle();
    await request.patch(path, { headers, data: { name: 'Remote private name' } });
    await expect(page.getByText('Remote private name', { exact: true })).toBeVisible();
    await expect(page.locator('#name')).toHaveValue('Unsaved socket draft');
    await expect(page.locator('#name')).toBeFocused();
    expect(await draft!.evaluate(element => element.isConnected)).toBe(true);
    const day = page.locator('.history[data-monitor="' + monitor.id + '"] li').nth(88);
    await day.focus(); const selected = await day.getAttribute('data-date');
    await page.getByLabel('Actions Remote private name', { exact: true }).click();
    const menu = page.locator('details.menu').filter({ has: page.getByLabel('Actions Remote private name', { exact: true }) });
    const publish = page.getByRole('button', { name: 'Publish Remote private name', exact: true });
    await publish.focus();
    await request.patch(path, { headers, data: { silenceSeconds: 600 } });
    await request.put(path + '/maintenance', { headers, data: { endsAt: Date.now() + 3600000 } });
    await expect(page.getByRole('button', { name: 'End Maintenance Remote private name', exact: true })).toBeVisible();
    await expect(menu).toHaveAttribute('open', ''); await expect(publish).toBeFocused();
    await expect(page.locator('.history[data-monitor="' + monitor.id + '"] [aria-current="true"]')).toHaveAttribute('data-date', selected!);
    await expect(page.locator('#name')).toHaveValue('Unsaved socket draft');
    await page.locator('#logout').click();
    await expect(page.locator('#monitor-rows')).toBeEmpty();
  } finally { await request.delete(path, { headers }); }
});
