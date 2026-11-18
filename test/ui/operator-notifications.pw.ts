// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebSocketRoute } from '@playwright/test';

const snapshot = { pageName: 'Private session', destinations: [{ id: 'hook', channel: 'webhook', url: 'https://private.example/hook' }], monitors: [{ id: 'private', name: 'Private Monitor', kind: 'http', url: 'https://private.example', state: 'up', published: false }], incidents: [] };
async function login(page: import('@playwright/test').Page) {
  await page.goto('/operator'); await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('renews on the same socket, reauthorizes snapshots and clears private state on denied renewal', async ({ page }) => {
  let live!: WebSocketRoute; let connections = 0; let tickets = 0; let denied = false; let reads = 0;
  const frames: string[] = [];
  await page.route('**/api/operator', route => { reads++; return route.fulfill({ json: snapshot }); });
  await page.route('**/api/operator/events/ticket', route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe('Bearer ui-test-secret');
    tickets++;
    return route.fulfill(denied ? { status: 401, json: { error: 'Unauthorized' } } : { json: { ticket: 'grant-' + tickets, expiresAt: Date.now() + 30000 } });
  });
  await page.routeWebSocket('**/api/operator/events', socket => {
    live = socket; connections++;
    socket.onMessage(message => { frames.push(String(message)); if (message !== 'ack') socket.send('authorized'); });
  });
  await page.clock.install();
  await login(page);
  await expect(page.locator('#updates-mode')).toBeHidden();
  await expect.poll(() => reads).toBe(2);
  await page.locator('#settings-button').click();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.locator('#webhookUrl').fill('https://draft.example/hook');
  await page.clock.runFor(240001);
  await expect.poll(() => tickets).toBe(2);
  await expect.poll(() => frames.some(frame => frame.includes('"renew"'))).toBe(true);
  expect(connections).toBe(1);
  await expect(page.locator('#webhookUrl')).toHaveValue('https://draft.example/hook');
  denied = true; await page.clock.runFor(240001);
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#monitor-rows')).toBeEmpty(); await expect(page.locator('#webhookUrl')).toHaveValue('');
  await expect(page.locator('#configuration')).toBeHidden();
  const count = tickets;
  await page.clock.runFor(600000); expect(tickets).toBe(count); expect(connections).toBe(1);
  expect(live).toBeDefined();
});

test('coalesces operator notices, reconnects with resync and polls only while disconnected and visible', async ({ page }) => {
  let live!: WebSocketRoute; let connections = 0; let reads = 0; let hold = false; let release: (() => void) | undefined;
  let data = { ...snapshot };
  await page.route('**/api/operator', async route => {
    reads++; const response = data;
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: response });
  });
  await page.route('**/api/operator/events/ticket', route => route.fulfill({ json: { ticket: 'grant', expiresAt: Date.now() + 30000 } }));
  await page.routeWebSocket('**/api/operator/events', socket => { live = socket; connections++; socket.onMessage(message => { if (message !== 'ack') socket.send('authorized'); }); });
  await login(page); await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(180000); expect(reads).toBe(2); await page.clock.resume();
  hold = true; live.send('changed'); await expect.poll(() => !!release).toBe(true);
  for (let i = 0; i < 100; i++) live.send('changed');
  data = { ...snapshot, pageName: 'Latest coalesced' }; hold = false; release!();
  await expect(page.locator('#pageName')).toHaveValue('Latest coalesced'); expect(reads).toBeLessThanOrEqual(4);
  data = { ...snapshot, pageName: 'Reconnect snapshot' }; live.close();
  await expect(page.locator('#updates-mode')).toBeVisible();
  await expect.poll(() => connections).toBe(2);
  await expect(page.locator('#pageName')).toHaveValue('Reconnect snapshot');
});

for (const boundary of ['ticket', 'snapshot', 'renewal']) {
  test('sign-out rejects a delayed ' + boundary + ' response and stops renewal/reconnection', async ({ page }) => {
    let live!: WebSocketRoute; let connections = 0; let tickets = 0; let release: (() => void) | undefined; let held = false;
    const frames: string[] = [];
    await page.route('**/api/operator', async route => {
      if (held && boundary === 'snapshot') await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: snapshot });
    });
    await page.route('**/api/operator/events/ticket', async route => {
      tickets++;
      if ((boundary === 'ticket' && tickets === 1) || (boundary === 'renewal' && tickets === 2)) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { ticket: 'grant', expiresAt: Date.now() + 30000 } });
    });
    await page.routeWebSocket('**/api/operator/events', socket => {
      live = socket; connections++;
      socket.onMessage(message => { frames.push(String(message)); if (message !== 'ack') socket.send('authorized'); });
    });
    await page.clock.install();
    await login(page);
    if (boundary !== 'ticket') await expect.poll(() => frames.length).toBeGreaterThan(0);
    if (boundary === 'snapshot') { held = true; live.send('changed'); }
    if (boundary === 'renewal') await page.clock.runFor(240001);
    await expect.poll(() => !!release).toBe(true);
    await page.locator('#logout').click();
    const count = frames.length; release!();
    await expect(page.locator('#login')).toBeVisible();
    await page.clock.runFor(600000);
    await expect(page.locator('#editor')).toBeHidden(); await expect(page.locator('#monitor-rows')).toBeEmpty();
    await expect(page.locator('#webhookUrl')).toHaveValue('');
    expect(frames.length).toBe(count); expect(connections).toBe(1);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('grant');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('ui-test-secret');
  });
}

test('failed sockets retain visible polling, stale feedback and clear UI on snapshot authorization loss', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  let status = 200; let reads = 0;
  await page.route('**/api/operator', route => { reads++; return route.fulfill({ status, json: snapshot }); });
  await page.clock.install(); await login(page); await expect(page.locator('#editor')).toBeVisible(); status = 503;
  await page.clock.runFor(60001); await expect(page.locator('#stale')).toBeVisible();
  await expect(page.getByText('Private Monitor', { exact: true })).toBeVisible();
  status = 200; await page.clock.runFor(60001); await expect(page.locator('#stale')).toBeHidden();
  status = 401; await page.clock.runFor(60001); await expect(page.locator('#login')).toBeVisible();
  const count = reads; await page.clock.runFor(120000); expect(reads).toBe(count);
});
