// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

for (const path of ['/', '/operator']) {
  test(`${path} separates ongoing and resolved Incidents with exact cross-day durations`, async ({ page, request }) => {
    await page.clock.install({ time: new Date('2026-11-02T08:15:00Z') });
    const data = {
      pageName: 'Incident ledger', monitors: [{ id: 'web', name: 'Website', state: 'down', kind: 'http', published: true }],
      incidents: [
        { monitorId: 'web', openedAt: Date.parse('2026-11-02T08:00:00Z'), closedAt: null },
        { monitorId: 'web', openedAt: Date.parse('2026-10-31T23:30:00Z'), closedAt: Date.parse('2026-11-01T01:00:00Z') },
        ...(path === '/operator' ? [{ monitorId: 'removed', monitorName: 'Deleted producer', openedAt: Date.parse('2026-11-01T08:15:00Z'), closedAt: null }] : []),
      ],
    };
    await page.route('**/api/operator', route => route.fulfill({ json: data }));
    await page.route('**/api/status', route => route.fulfill({ json: data }));
    if (path === '/') await page.route('**/*', async route => {
      if (new URL(route.request().url()).pathname !== '/') return route.fallback();
      const response = await request.post('/__ui/status', { data });
      return route.fulfill({ response });
    });
    await page.goto(path);
    if (path === '/operator') {
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
    const ongoing = page.getByRole('region', { name: 'Ongoing', exact: true });
    const resolved = page.getByRole('region', { name: 'Resolved', exact: true });
    await expect(ongoing.locator('.incident').first()).toContainText('Website');
    await expect(ongoing.locator('.incident').first()).toContainText('Ongoing');
    await expect(ongoing.locator('.incident').first()).toContainText('15 min');
    await expect(ongoing.locator('.incident').first()).not.toContainText('Recovered');
    await expect(resolved).toContainText('Recovered');
    await expect(resolved).toContainText('1 h 30 min');
    await expect(resolved.locator('time').first()).toContainText('Oct 31, 2026');
    await expect(resolved.locator('time').last()).toContainText('Nov 1, 2026');
    await expect(resolved.locator('time').first()).toHaveAttribute('datetime', '2026-10-31T23:30:00.000Z');
    await expect(page.locator('#page-clock')).toContainText('UTC');
    if (path === '/operator') {
      await expect(ongoing).toContainText('Deleted producer');
      await expect(ongoing).toContainText('Deleted Monitor');
      await expect(ongoing.locator('.incident').last()).toContainText('1 d');
    }
    await page.clock.runFor(60000);
    await expect(ongoing.locator('.incident').first()).toContainText('16 min');
    await expect(resolved).toContainText('1 h 30 min');
    for (const theme of ['light', 'dark', 'system']) {
      await page.locator('#theme').selectOption(theme);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(ongoing.locator('.incident').first()).toBeVisible();
    }
    data.incidents = [];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('No Incidents', { exact: true })).toBeVisible();
    await expect(ongoing).toHaveCount(0);
    await expect(resolved).toHaveCount(0);
  });
}

test('local midnight and repeated DST hours retain dates, offsets and elapsed time', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  await page.clock.install({ time: new Date('2026-11-01T12:00:00Z') });
  const data = { pageName: 'Local dates', monitors: [{ id: 'web', name: 'Website', state: 'up' }], incidents: [
    { monitorId: 'web', openedAt: Date.parse('2026-11-01T06:30:00Z'), closedAt: Date.parse('2026-11-01T07:30:00Z') },
    { monitorId: 'web', openedAt: Date.parse('2026-11-01T08:30:00Z'), closedAt: Date.parse('2026-11-01T09:30:00Z') },
  ] };
  await page.route('**/api/status', route => route.fulfill({ json: data }));
  await page.route(new URL('/', baseURL).href, async route => {
    const response = await context.request.post('/__ui/status', { data });
    await route.fulfill({ response });
  });
  await page.goto('/');
  const records = page.locator('.incident');
  await expect(records.first().locator('time').first()).toContainText('Oct 31, 2026, 11:30 PM PDT');
  await expect(records.first().locator('time').last()).toContainText('Nov 1, 2026, 12:30 AM PDT');
  await expect(records.last().locator('time').first()).toHaveText('1:30 AM PDT');
  await expect(records.last().locator('time').last()).toHaveText('1:30 AM PST');
  await expect(records.locator('.incident-duration')).toHaveText(['1 h 0 min', '1 h 0 min']);
  await context.close();
});
