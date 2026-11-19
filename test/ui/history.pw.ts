// SPDX-License-Identifier: AGPL-3.0-only
import { fulfillView } from './view-response';
import { expect, test } from '@playwright/test';
import { monitorAction } from './actions';

function snapshot() {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    state: 'empty', successes: 0, failures: 0, maintenance: 0,
  }));
  days[66] = { date: '2026-03-08', state: 'degraded', successes: 2, failures: 1, maintenance: 3 };
  return { pageName: 'Test status', monitors: [
    { id: 'web', name: 'Website', state: 'down', kind: 'http', published: true, history: { percentage: 66.6666667 as number | null, days } },
    { id: 'private', name: 'Private', state: 'maintenance', kind: 'http', published: false, history: null },
  ], incidents: [{ monitorId: 'web', openedAt: Date.parse('2026-03-08T09:30:00Z'), closedAt: Date.parse('2026-03-08T10:30:00Z') }] };
}

for (const settings of [
  { locale: 'en-US', timezoneId: 'America/Los_Angeles', before: '1:30 AM', after: '3:30 AM', bucket: 'Mar 8, 2026', start: 'Mar 7, 2026', end: 'Mar 8, 2026' },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', before: '10:30', after: '11:30', bucket: '8. März 2026', start: '8. März 2026', end: '9. März 2026' },
  { locale: 'en-GB', timezoneId: 'Asia/Katmandu', before: '15:15', after: '16:15', bucket: '8 Mar 2026', start: '8 Mar 2026', end: '9 Mar 2026' },
]) {
  test.describe(settings.timezoneId, () => {
    test.use({ locale: settings.locale, timezoneId: settings.timezoneId });
    for (const path of ['/', '/operator']) {
      test(`${path} localizes instants and inspects UTC history`, async ({ page, request }) => {
        const data = snapshot();
        await page.routeWebSocket(path === '/' ? '**/api/status/events/v2' : '**/api/operator/events/v2', socket => socket.close());
        await page.route('**/api/operator', route => fulfillView(route, { json: data }));
        if (path === '/') await page.route('**/*', async route => {
          if (new URL(route.request().url()).pathname === '/') {
            const response = await request.post('/__ui/status', { data: { ...data, monitors: data.monitors.slice(0, 1) } });
            return route.fulfill({ response });
          }
          await route.fallback();
        });
        await page.goto(path);
        if (path === '/operator') {
          await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await expect(page.getByText('Bars unavailable', { exact: true })).toBeVisible();
          await expect(page.getByRole('cell', { name: 'Maintenance', exact: true })).toBeVisible();
        }
        const times = page.locator('.incident time');
        await expect(times.nth(0)).toHaveAttribute('datetime', '2026-03-08T09:30:00.000Z');
        await expect(times.nth(0)).toContainText(settings.before);
        await expect(times.nth(1)).toContainText(settings.after);
        await expect(page.getByText('66.67%', { exact: true })).toBeVisible();
        await expect(page.getByText('past 90 days', { exact: true })).toBeVisible();
        await expect(page.locator('.history-detail').first()).toContainText('No observations');
        const strip = page.locator('.history').first();
        await expect(strip.locator('[tabindex="0"]')).toHaveCount(1);
        await strip.locator('[tabindex="0"]').focus();
        await page.keyboard.press('End');
        await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-03-31');
        await page.keyboard.press('Home');
        await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-01-01');
        await page.keyboard.press('ArrowRight');
        await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-01-02');
        await strip.locator('[data-date="2026-03-08"]').click();
        const detail = page.locator('.history-detail').first();
        await expect(detail).toContainText(settings.bucket + ' UTC');
        await expect(detail).toContainText('2 successful · 1 failed · 3 Maintenance');
        await expect(detail).not.toContainText('Mixed results;');
        await page.getByText('Exact time range', { exact: true }).click();
        await expect(detail).toContainText('2026-03-08 00:00 UTC → 2026-03-09 00:00 UTC');
        await expect(detail).toContainText(settings.start);
        await expect(detail).toContainText(settings.end);
        await expect(detail).toContainText(settings.timezoneId);
        await expect(strip.locator('[data-date="2026-03-08"]')).toHaveAttribute('aria-label', /Mixed results; 2 successes, 1 failures, 3 Maintenance/);
        if (path === '/') {
          await page.reload();
          await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-03-08');
        }
        if (path === '/operator') {
          data.monitors[0].history!.days.shift();
          data.monitors[0].history!.days.push({ date: '2026-04-01', state: 'empty', successes: 0, failures: 0, maintenance: 0 });
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-03-08');
          await expect(detail.locator('details')).toHaveAttribute('open', '');
          await monitorAction(page, 'Maintenance Website');
          await expect(page.getByLabel('End time (' + settings.timezoneId + ')', { exact: true })).toBeVisible();
          await page.locator('#maintenance-end').fill('2026-11-17T12:00');
          const write = page.waitForRequest(req => req.url().endsWith('/web/maintenance') && req.method() === 'PUT');
          await page.route('**/web/maintenance', route => fulfillView(route, { json: data }));
          await page.locator('#save-maintenance').click();
          const expected = settings.timezoneId === 'America/Los_Angeles' ? '2026-11-17T20:00:00Z' : settings.timezoneId === 'Europe/Berlin' ? '2026-11-17T11:00:00Z' : '2026-11-17T06:15:00Z';
          expect((await write).postDataJSON()).toEqual({ endsAt: Date.parse(expected) });
        }
      });
    }
  });
}

test('touch selects a day without adding tab stops', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.route('**/api/operator', route => fulfillView(route, { json: snapshot() }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('[data-date="2026-03-08"]').tap();
  await expect(page.locator('.history-detail')).toContainText('2 successful · 1 failed · 3 Maintenance');
  await expect(page.locator('.history [tabindex="0"]')).toHaveCount(1);
  await context.close();
});


test('empty, unavailable, and result states stay distinct through refresh and retention', async ({ page }) => {
  const data = snapshot();
  const history = data.monitors[0].history!;
  history.percentage = null;
  history.days.forEach(day => Object.assign(day, { state: 'empty', successes: 0, failures: 0, maintenance: 0 }));
  await page.route('**/api/operator', route => fulfillView(route, { json: data }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.percentage')).toHaveText('No observations');
  await expect(page.getByRole('cell', { name: 'Unavailable', exact: true })).toBeVisible();
  await expect(page.getByText('Bars unavailable', { exact: true })).toBeVisible();
  const strip = page.locator('.history');
  await strip.locator('[tabindex="0"]').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.history-detail')).toContainText('No observations');
  data.monitors[0].history = null;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText('Bars unavailable', { exact: true })).toHaveCount(2);
  data.monitors[0].history = history;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-01-01');
  for (const [state, label, successes, failures, maintenance] of [
    ['up', 'Successful checks', 1, 0, 0], ['down', 'Failed checks', 0, 1, 0], ['maintenance', 'Maintenance', 0, 0, 1],
  ] as const) {
    Object.assign(history.days[0], { state, successes, failures, maintenance });
    history.percentage = state === 'up' ? 100 : state === 'down' ? 0 : null;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('aria-label', new RegExp(label + '; ' + successes + ' successes, ' + failures + ' failures, ' + maintenance + ' Maintenance'));
    await expect(page.locator('.history-detail')).toContainText(successes + ' successful · ' + failures + ' failed' + (maintenance ? ' · 1 Maintenance' : ''));
  }
  history.days.shift();
  history.days.push({ date: '2026-04-01', state: 'empty', successes: 0, failures: 0, maintenance: 0 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(strip.locator('[tabindex="0"]')).toHaveAttribute('data-date', '2026-04-01');
});

test('fall daylight-saving repeated hours retain distinct exact instants', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  const request = context.request;
  const data = snapshot();
  data.incidents[0].openedAt = Date.parse('2026-11-01T08:30:00Z');
  data.incidents[0].closedAt = Date.parse('2026-11-01T09:30:00Z');
  await page.route(new URL('/', baseURL).href, async route => {
    const response = await request.post('/__ui/status', { data });
    await route.fulfill({ response });
  });
  await page.goto('/');
  await expect(page.locator('.incident time').nth(0)).toContainText('1:30 AM PDT');
  await expect(page.locator('.incident time').nth(1)).toContainText('1:30 AM PST');
  await expect(page.locator('.incident time').nth(0)).toHaveAttribute('datetime', '2026-11-01T08:30:00.000Z');
  await expect(page.locator('.incident time').nth(1)).toHaveAttribute('datetime', '2026-11-01T09:30:00.000Z');
  await context.close();
});


test('Maintenance preserves an unchanged fold instant and rejects gap or ambiguous edits', async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  await page.routeWebSocket('**/api/operator/events/v2', socket => socket.close());
  const data = snapshot();
  Object.assign(data.monitors[0], { maintenance: { endsAt: Date.parse('2027-11-07T09:30:25Z') } });
  const writes: unknown[] = [];
  await page.route('**/api/operator', route => fulfillView(route, { json: data }));
  await page.route('**/web/maintenance', route => {
    writes.push(route.request().postDataJSON());
    return fulfillView(route, { json: data });
  });
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await monitorAction(page, 'Maintenance Website');
  await expect(page.locator('#maintenance-end')).toHaveValue('2027-11-07T01:30');
  await page.locator('#save-maintenance').click();
  await expect(page.locator('#maintenance')).toBeHidden();
  expect(writes).toEqual([{ endsAt: Date.parse('2027-11-07T09:30:25Z') }]);
  await monitorAction(page, 'Maintenance Website');
  for (const value of ['2027-03-14T02:30', '2027-11-07T01:45']) {
    await page.locator('#maintenance-end').fill(value);
    await page.locator('#save-maintenance').click();
    await expect(page.locator('#maintenance-end')).toHaveJSProperty('validationMessage', 'Choose an unambiguous local time that exists in America/Los_Angeles.');
    expect(writes).toHaveLength(1);
  }
  await page.locator('#maintenance-end').fill('2027-11-07T02:30');
  await page.locator('#save-maintenance').click();
  await expect(page.locator('#maintenance')).toBeHidden();
  expect(writes[1]).toEqual({ endsAt: Date.parse('2027-11-07T10:30:00Z') });
  await context.close();
});

for (const path of ['/', '/operator']) {
  test(`${path} shows one runtime page clock independently of snapshot freshness`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-16T12:00:00Z') });
    await page.goto(path);
    const clock = page.locator('#page-clock');
    await expect(clock).toHaveCount(1);
    await expect(clock).toHaveAttribute('datetime', /^2026-11-16T12:00:/);
    await expect(clock).toContainText('2026');
    await expect(clock).toContainText('UTC');
    await page.clock.runFor(60000);
    await expect(clock).toHaveAttribute('datetime', /^2026-11-16T12:01:/);
    await expect(clock).not.toContainText(/updated|fresh/i);
  });
}

test('today stays compact and becomes an explicit historical UTC date after midnight', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-03-31T23:59:00Z') });
  await page.route('**/api/operator', route => fulfillView(route, { json: snapshot() }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.history-counts')).toHaveText('No observations');
  await page.clock.runFor(60000);
  await expect(page.locator('.history-counts')).toHaveText('Mar 31, 2026 UTC · No observations');
  await expect(page.locator('.history [tabindex="0"]')).toHaveAttribute('data-date', '2026-03-31');
});
