// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
test('operator configures Calendar HTTP with authoritative live explanation and zone preview, then returns to Interval', async ({ page, request }) => {
  const headers = { authorization: 'Bearer ui-test-secret' };
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
  await page.getByLabel('Monitor name', { exact: true }).fill('Calendar UI');
  await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid');
  await page.getByLabel('Schedule', { exact: true }).selectOption('calendar');
  await expect(page.getByLabel('Interval', { exact: true })).toBeHidden();
  await page.getByLabel('Cron', { exact: true }).fill('0 9 15 * 1');
  await page.getByLabel('Timezone', { exact: true }).fill('America/New_York');
  await expect(page.locator('#schedule-explanation')).toContainText('day-of-month 15 OR Monday');
  await expect(page.locator('#schedule-occurrences time')).toHaveCount(3);
  await expect(page.locator('#schedule-occurrences')).toContainText('America/New_York');
  await page.getByLabel('Cron', { exact: true }).fill('@daily');
  await expect(page.locator('#schedule-explanation')).toContainText('five cron fields');
  await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
  await expect(page.locator('#configuration')).toBeVisible();
  await page.getByLabel('Cron', { exact: true }).fill('0 9 15 * 1');
  await expect(page.locator('#schedule-occurrences time')).toHaveCount(3);
  const saving = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/monitors'));
  await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
  const saved = await saving;
  expect(saved.status()).toBe(201);
  const monitor = (await saved.json()).monitors.at(-1);
  try {
    expect(monitor).toMatchObject({ scheduleMode: 'calendar', cron: '0 9 15 * 1', timezone: 'America/New_York', intervalSeconds: 60 });
    await page.getByRole('button', { name: 'Edit Calendar UI', exact: true }).click();
    await expect(page.getByLabel('Schedule', { exact: true })).toHaveValue('calendar');
    await expect(page.getByLabel('Cron', { exact: true })).toHaveValue('0 9 15 * 1');
    await expect(page.locator('#schedule-occurrences time')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Schedule', { exact: true }).selectOption('interval');
    await expect(page.getByLabel('Cron', { exact: true })).toBeHidden();
    await page.getByLabel('Interval unit', { exact: true }).selectOption('minutes');
    await page.getByLabel('Interval', { exact: true }).fill('5');
    const editing = page.waitForResponse(response => response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    expect((await (await editing).json()).monitors.find((item: { id: string }) => item.id === monitor.id)).toMatchObject({ id: monitor.id, scheduleMode: 'interval', intervalSeconds: 300 });
  } finally { await request.delete('/api/operator/monitors/' + monitor.id, { headers }); }
});
