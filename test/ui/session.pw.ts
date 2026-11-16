// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

const snapshot = {
  pageName: 'Private page', webhookUrl: 'https://private.example/hook', incidents: [],
  monitors: [{ id: 'private', name: 'Private Monitor', kind: 'http', url: 'https://private.example', state: 'up', published: false }],
};
const preview = {
  explanation: 'At 09:00; every day (UTC).', timezone: 'UTC',
  occurrences: [Date.parse('2026-11-17T09:00Z'), Date.parse('2026-11-18T09:00Z'), Date.parse('2026-11-19T09:00Z')],
};

test.beforeEach(async ({ page }) => {
  // Calendar races are independent of subscription transport.
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
  await page.route('**/api/operator', route => route.fulfill({ json: snapshot }));
  await page.clock.install({ time: new Date('2026-11-16T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-16T12:00:01Z'));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
});

for (const status of [200, 401, 503]) {
  test(`previous-session Calendar preview ${status} cannot alter a newer sign-in and editor`, async ({ page }) => {
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/operator/schedule-preview', async route => {
      if (!held) {
        held = true;
        await gate;
        await route.fulfill({ status, json: status === 200 ? { ...preview, explanation: 'Previous session preview' } : { error: 'Previous session error' } });
      } else await route.fulfill({ json: preview });
    });
    try {
      await page.getByLabel('Schedule', { exact: true }).selectOption('calendar');
      await page.getByLabel('Cron', { exact: true }).fill('0 8 * * *');
      await page.clock.runFor(200);
      await expect.poll(() => held).toBe(true);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
      await page.getByLabel('Monitor name', { exact: true }).fill('New session draft');
      await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://new.example');
      await page.getByLabel('Schedule', { exact: true }).selectOption('calendar');
      await page.getByLabel('Cron', { exact: true }).fill('0 9 * * *');
      await page.clock.runFor(200);
      await expect(page.locator('#schedule-explanation')).toHaveText(preview.explanation);
      await expect(page.locator('#schedule-occurrences time')).toHaveCount(3);
      const occurrences = await page.locator('#schedule-occurrences').textContent();
      const response = page.waitForResponse(response => response.url().endsWith('/schedule-preview'));
      release();
      await (await response).finished();
      await page.clock.resume();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator('#editor')).toBeVisible();
      await expect(page.locator('#login')).toBeHidden();
      await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('New session draft');
      await expect(page.getByLabel('HTTP(S) target', { exact: true })).toHaveValue('https://new.example');
      await expect(page.getByLabel('Cron', { exact: true })).toHaveValue('0 9 * * *');
      await expect(page.locator('#schedule-explanation')).toHaveText(preview.explanation);
      await expect(page.locator('#schedule-occurrences')).toHaveText(occurrences!);
      await expect(page.locator('#webhookUrl')).toHaveValue(snapshot.webhookUrl);
      await expect(page.locator('#message')).toBeEmpty();
      await expect(page.locator('#stale')).toBeHidden();
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('older current-session Calendar preview denial clears private state after a newer preview', async ({ page }) => {
  let held = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/operator/schedule-preview', async route => {
    if (!held) {
      held = true;
      await gate;
      await route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
    } else await route.fulfill({ json: preview });
  });
  try {
    await page.getByLabel('Monitor name', { exact: true }).fill('Private draft');
    await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://draft.private.example');
    await page.getByLabel('Schedule', { exact: true }).selectOption('calendar');
    await page.getByLabel('Cron', { exact: true }).fill('0 8 * * *');
    await page.clock.runFor(200);
    await expect.poll(() => held).toBe(true);
    await page.getByLabel('Cron', { exact: true }).fill('0 9 * * *');
    await page.clock.runFor(200);
    await expect(page.locator('#schedule-explanation')).toHaveText(preview.explanation);
    await expect(page.locator('#schedule-occurrences time')).toHaveCount(3);
    const response = page.waitForResponse(response => response.url().endsWith('/schedule-preview'));
    release();
    await (await response).finished();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#editor')).toBeHidden();
    await expect(page.locator('#monitor-rows')).toBeEmpty();
    await expect(page.getByLabel('Installation secret', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('HTTP(S) target', { exact: true })).toHaveValue('');
    await expect(page.locator('#webhookUrl')).toHaveValue('');
    await expect(page.locator('#message')).toHaveText('Unauthorized');
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
