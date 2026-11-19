// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { monitorAction } from './actions';

async function renderOperatorFixture(page: Page, snapshot: object, monitorId: string) {
  const response = await page.request.post('/__ui/operator', { data: snapshot });
  expect(response.ok()).toBe(true);
  const json = await response.json();
  await page.route('**/api/operator', route => route.fulfill({ json }));
  await page.route('**/api/operator/monitors/' + monitorId, route => route.fulfill({ json }));
}

test('Schedule carries the floor and suspension while State shows the last observed result', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const base = { kind: 'http', url: 'https://example.invalid', published: true, lastResult: null, history: null };
  const snapshot = {
    pageName: 'Floor test', minCheckIntervalSeconds: 180, incidents: [],
    monitors: [
      { ...base, id: 'interval', name: 'Interval site', scheduleMode: 'interval', state: 'up', intervalSeconds: 60, effectiveIntervalSeconds: 180 },
      { ...base, id: 'matched', name: 'Matched site', scheduleMode: 'interval', state: 'up', intervalSeconds: 180, effectiveIntervalSeconds: 180 },
      { ...base, id: 'calendar', name: 'Calendar site', scheduleMode: 'calendar', state: 'down', cron: '* * * * *', timezone: 'UTC', scheduleSuspended: true, scheduleSuspensionFloorSeconds: 180 },
      { ...base, id: 'heartbeat', name: 'Producer', kind: 'heartbeat', scheduleMode: 'interval', state: 'up', intervalSeconds: 60 },
    ],
  };
  await renderOperatorFixture(page, snapshot, 'interval');
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const intervalRow = page.getByRole('row', { name: /Interval site/ });
  await expect(intervalRow.getByRole('cell', { name: 'Operational', exact: true })).toBeVisible();
  await expect(intervalRow.getByRole('cell', { name: 'Every 3 min (saved 1 min)', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /Matched site/ }).getByRole('cell', { name: 'Every 3 min', exact: true })).toBeVisible();
  const calendarRow = page.getByRole('row', { name: /Calendar site/ });
  await expect(calendarRow.getByRole('cell', { name: 'Unavailable', exact: true })).toBeVisible();
  await expect(calendarRow.getByRole('cell', { name: 'Suspended (3 min minimum)', exact: true })).toBeVisible();
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

for (const floor of [180, 60]) {
  test('editing a suspended Calendar preserves its schedule at a ' + floor + ' second floor', async ({ page }) => {
    const monitor = {
      kind: 'http', id: 'calendar', name: 'Calendar site', url: 'https://example.invalid', published: true,
      state: 'unknown', lastResult: null, scheduleMode: 'calendar', cron: '* * * * *', timezone: 'UTC',
      scheduleSuspended: true, scheduleSuspensionFloorSeconds: 180,
    };
    const snapshot = {
      pageName: 'Floor test', minCheckIntervalSeconds: floor, incidents: [], monitors: [monitor],
      destinations: [{ id: 'webhook', channel: 'webhook', url: 'https://hooks.example/alert' }],
    };
    await renderOperatorFixture(page, snapshot, monitor.id);
    await page.route('**/api/operator/schedule-preview', route => {
      const { cron } = route.request().postDataJSON();
      return floor === 180 && cron === monitor.cron
        ? route.fulfill({ status: 400, json: { error: 'Calendar occurrences must be at least 180 seconds apart' } })
        : route.fulfill({ json: { cron, timezone: 'UTC', explanation: 'Calendar preview', occurrences: [] } });
    });
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const preview = page.waitForRequest('**/api/operator/schedule-preview');
    await monitorAction(page, 'Edit Calendar site');
    await expect(page.locator('#schedule-explanation')).toContainText(floor === 180 ? '180 seconds' : 'Calendar preview');
    await page.getByLabel('Monitor name', { exact: true }).fill('Renamed Calendar');
    await page.getByRole('checkbox', { name: /hooks.example/ }).check();
    const saveRequest = () => page.waitForRequest(request =>
      request.method() === 'PATCH' && request.url().endsWith('/monitors/calendar'), { timeout: 3000 });
    const save = saveRequest();
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    const fields = (await save).postDataJSON();
    expect(fields).toMatchObject({ name: 'Renamed Calendar', destinationChanges: { webhook: true } });
    for (const field of ['scheduleMode', 'cron', 'timezone']) expect(fields).not.toHaveProperty(field);
    expect((await preview).postDataJSON()).toMatchObject({ outbound: true });
    await expect(page.locator('#configuration')).toBeHidden();

    await monitorAction(page, 'Edit Calendar site');
    if (floor === 180) await page.getByLabel('Cron', { exact: true }).fill('*/3 * * * *');
    await expect(page.locator('#schedule-explanation')).toHaveText('Calendar preview');
    const resume = saveRequest();
    await page.getByRole('button', { name: floor === 180 ? 'Save Monitor' : 'Save and Resume', exact: true }).click();
    expect((await resume).postDataJSON()).toMatchObject({
      scheduleMode: 'calendar', cron: floor === 180 ? '*/3 * * * *' : '* * * * *', timezone: 'UTC',
    });
  });
}
