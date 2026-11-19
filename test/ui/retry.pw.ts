// SPDX-License-Identifier: AGPL-3.0-only
import { fulfillView } from './view-response';
import { expect, test } from '@playwright/test';

for (const path of ['/', '/operator']) {
  test(`${path} offers Retry only after failed reads and retains it through pending and failed retries`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });
    let failure = false;
    let release: (() => void) | undefined;
    let hold = false;
    let reads = 0;
    const api = path === '/' ? '**/api/status' : '**/api/operator';
    await page.route(api, async route => {
      reads++;
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      await fulfillView(route, failure ? { status: 503, json: { error: 'Unavailable' } } : { json: { pageName: 'Recovered', monitors: [], incidents: [], webhookUrl: null } });
    });
    await page.goto(path);
    if (path === '/operator') {
      await page.locator('#secret').fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('#editor')).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeHidden();
    failure = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('#stale span')).toBeVisible();
    for (const theme of ['system', 'light', 'dark']) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
      await expect(retry).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(page.locator('#sync-announcement')).toHaveText('Updates unavailable');
    hold = true;
    await retry.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => !!release).toBe(true);
    await expect(page.getByRole('button', { name: 'Retrying…', exact: true })).toBeDisabled();
    await expect(page.locator('#sync-announcement')).toHaveText('Retrying updates');
    await expect(page.locator('#stale span')).toBeVisible();
    const before = reads;
    await page.keyboard.press('Enter');
    expect(reads).toBe(before);
    failure = false; hold = false; release!();
    await expect(retry).toBeHidden();
    await expect(page.locator('#stale')).toBeHidden();
    await expect(page.locator('#sync-announcement')).toHaveText('Updates restored');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    if (path === '/operator') await expect(page.locator('#editor')).toBeVisible();
  });
}

for (const path of ['/', '/operator']) {
  test(`${path} retries an initial read failure and automatically recovers subsequent failures`, async ({ page, request, baseURL }) => {
    await page.clock.install();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });
    const data = { pageName: 'Initial', webhookUrl: null, monitors: [], incidents: [] };
    // The public HTML is the initial snapshot; an empty one still needs working recovery.
    if (path === '/') await page.route(baseURL! + '/', async route => {
      const response = await request.post('/__ui/status', { data });
      await route.fulfill({ response });
    });
    let failure = true;
    let reads = 0;
    await page.route(path === '/' ? '**/api/status' : '**/api/operator', route => {
      reads++;
      return fulfillView(route, failure ? { status: 503, json: { error: 'Unavailable' } } : { json: data });
    });
    await page.goto(path);
    if (path === '/operator') {
      await page.locator('#secret').fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    } else await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    failure = false;
    await retry.click();
    await expect(retry).toBeHidden();
    if (path === '/operator') await expect(page.locator('#editor')).toBeVisible();
    // Disconnected polling alone leaves no failed-read indicator.
    await expect(page.locator('#updates-mode')).toBeVisible();
    failure = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(retry).toBeVisible();
    failure = false;
    const before = reads;
    await page.clock.fastForward(60000);
    await expect.poll(() => reads).toBeGreaterThan(before);
    await expect(retry).toBeHidden();
    await expect(page.locator('#sync-announcement')).toHaveText('Updates restored');
    await expect(page.locator('#stale')).toBeHidden();
  });
}

test('operator writes keep a failed-read indicator and denied Retry ends the Operator session', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
  let status = 200;
  const data = { pageName: 'Saved', webhookUrl: null, monitors: [], incidents: [] };
  await page.route('**/api/operator', route => fulfillView(route, { status: route.request().method() === 'PUT' ? 200 : status, json: data }));
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#settings-button').click();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.locator('#destination-address').fill('https://example.com/unsaved');
  status = 503;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#stale')).toBeVisible();
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('Saved');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.locator('#destination-address')).toHaveValue('https://example.com/unsaved');
  status = 401;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#secret')).toBeFocused();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#destination-address')).toHaveValue('');
  await expect(page.locator('#stale')).toBeHidden();
  await expect(page.locator('#message')).toHaveText('Unauthorized');
});

test('a save superseding a pending Retry leaves Retry usable after that read settles', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
  const data = { pageName: 'Original', webhookUrl: null, monitors: [], incidents: [] };
  await page.route('**/api/operator', route => fulfillView(route, { json: data }));
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#settings-button').click();
  let hold = false;
  let release!: () => void;
  await page.route('**/api/operator', async route => {
    if (route.request().method() === 'PUT') return fulfillView(route, { json: { ...data, pageName: 'Saved' } });
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#stale')).toBeVisible();
  hold = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('Saved');
  release();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await expect(page.locator('#stale')).toBeVisible();
});
