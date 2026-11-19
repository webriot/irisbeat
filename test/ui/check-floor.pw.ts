// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { monitorAction } from './actions';

test('Schedule carries the floor and suspension while State shows the last observed result', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const base = { kind: 'http', url: 'https://example.invalid', published: true, lastResult: null, history: null };
  const snapshot = {
    pageName: 'Floor test', minCheckIntervalSeconds: 180, incidents: [],
    monitors: [
      { ...base, id: 'interval', name: 'Interval site', scheduleMode: 'interval', state: 'up', intervalSeconds: 60, effectiveIntervalSeconds: 180 },
      { ...base, id: 'calendar', name: 'Calendar site', scheduleMode: 'calendar', state: 'down', cron: '* * * * *', timezone: 'UTC', scheduleSuspended: true, scheduleSuspensionFloorSeconds: 180 },
      { ...base, id: 'heartbeat', name: 'Producer', kind: 'heartbeat', scheduleMode: 'interval', state: 'up', intervalSeconds: 60 },
    ],
  };
  await page.route('**/api/operator', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/operator/monitors/interval', route => route.fulfill({ json: snapshot }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const intervalRow = page.getByRole('row', { name: /Interval site/ });
  await expect(intervalRow.getByRole('cell', { name: 'Operational', exact: true })).toBeVisible();
  await expect(intervalRow.getByRole('cell', { name: /Every 3 min.*Saved 1 min/ })).toBeVisible();
  const calendarRow = page.getByRole('row', { name: /Calendar site/ });
  await expect(calendarRow.getByRole('cell', { name: 'Unavailable', exact: true })).toBeVisible();
  await expect(calendarRow.getByRole('cell', { name: /Suspended.*3 min minimum/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Producer/ }).getByRole('cell', { name: 'Watchdog', exact: true })).toBeVisible();
  expect(await page.locator('body').evaluate(body => body.scrollWidth)).toBeLessThanOrEqual(390);

  await monitorAction(page, 'Edit Interval site');
  const interval = page.getByLabel('Interval', { exact: true });
  await expect(interval).toHaveValue('60');
  await interval.fill('120');
  expect(await interval.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(false);
  await interval.fill('180');
  expect(await interval.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await interval.fill('60');
  const saved = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/monitors/interval'));
  await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
  expect((await saved).postDataJSON()).not.toHaveProperty('intervalSeconds');
  await expect(interval).toBeHidden();
  await monitorAction(page, 'Edit Producer');
  await expect(page.getByLabel('Expectation', { exact: true })).toHaveAttribute('min', '60');
});
