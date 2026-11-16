// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import * as ui from '../../src/ui.ts';

const day = 86400000;
const at = Date.parse('2026-01-01T00:30:00Z');
function snapshot() {
  return {
    pageName: 'Services', webhookUrl: null,
    monitors: [{ id: 'website', name: 'Website', kind: 'http', url: 'https://example.com', published: true, state: 'down',
      maintenance: { endsAt: at },
      history: { percentage: null, days: Array.from({ length: 90 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 1) - (89 - i) * day).toISOString().slice(0, 10),
        state: 'empty', successes: 0, failures: 0, maintenance: 0,
      })) },
    }],
    incidents: [{ id: 'incident', monitorId: 'website', openedAt: at, closedAt: null }],
  };
}

test.describe('touch and status distinctions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  test('tap announces counted results, Maintenance, empty days, and unavailable history separately', async ({ page }) => {
    const data = snapshot();
    data.monitors[0].history.days[87] = { date: '2025-12-30', state: 'maintenance', successes: 0, failures: 0, maintenance: 2 };
    data.monitors[0].history.days[88] = { date: '2025-12-31', state: 'degraded', successes: 1, failures: 2, maintenance: 1 };
    data.monitors[0].history.days[89] = { date: '2026-01-01', state: 'down', successes: 0, failures: 3, maintenance: 0 };
    await serve(page, data, true);
    const buttons = page.locator('.history button');
    await buttons.nth(87).tap();
    await expect(page.locator('.history-detail')).toContainText('Maintenance; 0 successes, 0 failures, 2 Maintenance');
    await buttons.nth(88).tap();
    await expect(page.locator('.history-detail')).toContainText('Mixed results; 1 successes, 2 failures, 1 Maintenance');
    await buttons.nth(89).tap();
    await expect(page.locator('.history-detail')).toContainText('Failed checks; 0 successes, 3 failures');
    await buttons.nth(86).tap();
    await expect(page.locator('.history-detail')).toContainText('No observations');
    data.monitors[0].history = null;
    await page.getByRole('button', { name: 'Refresh', exact: true }).tap();
    await expect(page.getByText('Bars unavailable', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Unavailable', exact: true })).toBeVisible();
    await expect(page.getByText('No observations', { exact: true })).toHaveCount(0);
    await expect(buttons).toHaveCount(0);
  });
});

for (const scenario of [
  { timezoneId: 'America/Los_Angeles', date: '2026-03-08', before: '2026-03-08T09:30:00Z', after: '2026-03-08T10:30:00Z', beforeLocal: '2026-03-08T01:30', afterLocal: '2026-03-08T03:30', range: /Mar 7, 2026.*4:00:00 PM PST.*Mar 8, 2026.*5:00:00 PM PDT/ },
  { timezoneId: 'Europe/Berlin', date: '2026-03-29', before: '2026-03-29T00:30:00Z', after: '2026-03-29T01:30:00Z', beforeLocal: '2026-03-29T01:30', afterLocal: '2026-03-29T03:30', range: /Mar 29, 2026.*1:00:00 AM GMT\+1.*Mar 30, 2026.*2:00:00 AM GMT\+2/ },
]) {
  test.describe('DST ' + scenario.timezoneId, () => {
    test.use({ locale: 'en-US', timezoneId: scenario.timezoneId });
    test('keeps the UTC bucket fixed and converts Maintenance across the spring clock change', async ({ page }) => {
      const data = snapshot();
      data.monitors[0].maintenance.endsAt = Date.parse(scenario.before);
      data.monitors[0].history.days[89].date = scenario.date;
      const writes = await serve(page, data, true);
      await expect(page.locator('.history-detail')).toHaveText(scenario.range);
      await page.getByLabel('Actions for Website', { exact: true }).click();
      await page.getByRole('button', { name: 'Replace Maintenance Website', exact: true }).click();
      await expect(page.locator('#maintenance-end')).toHaveValue(scenario.beforeLocal);
      await page.locator('#maintenance-end').fill(scenario.afterLocal);
      await page.locator('#save-maintenance').click();
      expect(writes.at(-1)).toEqual({ endsAt: Date.parse(scenario.after) });
    });
  });
}
async function serve(page, data, operator = false) {
  const writes = [];
  await page.route('http://irisbeat.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) {
      if (route.request().method() !== 'GET') writes.push(route.request().postDataJSON());
      return route.fulfill({ json: data });
    }
    const assets = { '/theme.js': ['text/javascript', ui.themeScript], '/status.js': ['text/javascript', ui.statusScript], '/app.css': ['text/css', ui.styleSheet], '/operator.js': ['text/javascript', ui.operatorScript], '/presentation.js': ['text/javascript', ui.presentationScript] };
    const [contentType, body] = assets[path] || ['text/html', operator ? ui.operatorPage() : ui.statusPage(data)];
    await route.fulfill({ contentType, body });
  });
  await page.goto('http://irisbeat.test/' + (operator ? 'operator' : ''));
  if (operator) {
    await page.getByLabel('Installation secret', { exact: true }).fill('memory-only');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Monitor', exact: true })).toBeVisible();
  }
  return writes;
}

for (const scenario of [
  { locale: 'en-US', timezoneId: 'America/Los_Angeles', instant: /Dec 31, 2025.*4:30.*PM/, local: '2025-12-31T16:30', label: 'Jan 1, 2026 UTC' },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', instant: /01\.01\.2026.*01:30/, local: '2026-01-01T01:30', label: '01.01.2026 UTC' },
  { locale: 'en-GB', timezoneId: 'Asia/Kolkata', instant: /1 Jan 2026.*06:00/, local: '2026-01-01T06:00', label: '1 Jan 2026 UTC', zoneLabel: 'Asia/Calcutta' },
]) {
  test.describe(scenario.timezoneId, () => {
    test.use({ locale: scenario.locale, timezoneId: scenario.timezoneId });
    test('localizes Incidents and submits local Maintenance as the exact instant', async ({ page }) => {
      const data = snapshot();
      await serve(page, data);
      await expect(page.locator('time')).toHaveText(scenario.instant);
      await expect(page.locator('time')).toHaveAttribute('datetime', '2026-01-01T00:30:00.000Z');
      const writes = await serve(page, data, true);
      await expect(page.locator('#incidents time')).toHaveText(scenario.instant);
      await page.getByLabel('Actions for Website', { exact: true }).click();
      await page.getByRole('button', { name: 'Replace Maintenance Website', exact: true }).click();
      await expect(page.getByLabel('End time (' + (scenario.zoneLabel || scenario.timezoneId) + ')', { exact: true })).toHaveValue(scenario.local);
      await page.locator('#save-maintenance').click();
      expect(writes.at(-1)).toEqual({ endsAt: at });
    });
    test('inspects UTC buckets through one keyboard entry and keeps the selection on refresh', async ({ page }) => {
      const data = snapshot();
      await serve(page, data, true);
      const strip = page.getByRole('list', { name: '90 UTC days of availability' });
      await expect(page.getByText('90 UTC days', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Availability', { exact: true })).toHaveText('No observations');
      await expect(strip.locator('[tabindex="0"]')).toHaveCount(1);
      await expect(strip.getByRole('button').last()).toHaveAccessibleName(new RegExp(scenario.label));
      await strip.locator('[tabindex="0"]').focus();
      await page.keyboard.press('ArrowLeft');
      await expect(strip.getByRole('button').nth(88)).toBeFocused();
      await expect(strip.getByRole('button').nth(88)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.history-detail')).toContainText('No observations');
      await page.keyboard.press('Home');
      await expect(strip.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('End');
      await expect(strip.getByRole('button').last()).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(strip.getByRole('button').last()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(strip.getByRole('button').last()).not.toBeFocused();
      await strip.getByRole('button').nth(30).click();
      const selectedDate = data.monitors[0].history.days[30].date;
      await page.getByLabel('Actions for Website', { exact: true }).click();
      await page.getByRole('button', { name: 'Edit Website', exact: true }).click();
      await page.getByLabel('Monitor name', { exact: true }).fill('Unsaved name');
      data.monitors[0].history.days.shift();
      data.monitors[0].history.days.push({ date: '2026-01-02', state: 'down', successes: 0, failures: 1, maintenance: 0 });
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(strip.locator('[aria-pressed="true"]')).toHaveAttribute('data-date', selectedDate);
      await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('Unsaved name');
    });
  });
}

test('isolates selected days by Monitor and retains selection through a missing history response', async ({ page }) => {
  const data = snapshot();
  data.monitors.push({ ...structuredClone(data.monitors[0]), id: 'other', name: 'Other' });
  await serve(page, data, true);
  const strips = page.locator('.history');
  const first = strips.nth(0);
  const second = strips.nth(1);
  await first.getByRole('button').nth(10).click();
  await second.getByRole('button').nth(20).click();
  const history = data.monitors[0].history;
  data.monitors[0].history = null;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Bars unavailable', { exact: true })).toBeVisible();
  data.monitors[0].history = history;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(first.locator('[aria-pressed="true"]')).toHaveAttribute('data-date', history.days[10].date);
  await expect(second.locator('[aria-pressed="true"]')).toHaveAttribute('data-date', history.days[20].date);
  await expect(page.locator('.history [tabindex="0"]')).toHaveCount(2);
});


test('public automatic refresh preserves the selected UTC day and focus while updating details through rollover', async ({ page }) => {
  await page.clock.install();
  const data = snapshot();
  await serve(page, data);
  const selected = page.locator('.history button').nth(30);
  await selected.click();
  const date = await selected.getAttribute('data-date');
  const node = await selected.elementHandle();
  const before = await selected.getAttribute('aria-label');
  let navigations = 0;
  page.on('framenavigated', () => navigations++);
  Object.assign(data.monitors[0].history.days[30], { state: 'degraded', successes: 2, failures: 1 });
  data.monitors[0].history.days.shift();
  data.monitors[0].history.days.push({ date: '2026-01-02', state: 'empty', successes: 0, failures: 0, maintenance: 0 });
  const response = page.waitForResponse('http://irisbeat.test/api/status');
  await page.clock.runFor(60000);
  await response;
  const retained = page.locator('.history button[data-date="' + date + '"]');
  await expect(retained).toBeFocused();
  expect(await retained.evaluate((button, old) => button === old, node)).toBe(true);
  await expect(retained).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.history [tabindex="0"]')).toHaveCount(1);
  await expect(retained).not.toHaveAttribute('aria-label', before);
  await expect(retained).toHaveAccessibleName(/Mixed results; 2 successes, 1 failures/);
  await expect(page.locator('.history-detail')).toHaveText(await retained.getAttribute('aria-label'));
  expect(navigations).toBe(0);
});

test('operator polling preserves inline drafts, open menus, history selection and Settings focus', async ({ page }) => {
  await page.clock.install();
  const data = snapshot();
  data.monitors.push({ ...structuredClone(data.monitors[0]), id: 'other', name: 'Other' });
  await serve(page, data, true);
  const poll = async () => {
    const response = page.waitForResponse('http://irisbeat.test/api/operator');
    await page.clock.runFor(60000);
    await response;
    await expect(page.getByRole('cell', { name: data.monitors[0].name, exact: true })).toBeVisible();
  };
  const selected = page.locator('.history').first().locator('button').nth(30);
  await selected.click();
  const selectedDate = await selected.getAttribute('data-date');
  const selectedNode = await selected.elementHandle();
  const panel = await page.locator('#inline-panels').elementHandle();
  await page.getByLabel('Actions for Website', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit Website', exact: true }).click();
  const name = page.getByLabel('Monitor name', { exact: true });
  await name.fill('Unsaved Monitor');
  await name.evaluate(input => input.setSelectionRange(2, 8));
  const nameNode = await name.elementHandle();
  data.monitors[0].name = 'Renamed';
  data.monitors[0].state = 'up';
  data.monitors[0].history.days[30].successes = 2;
  await poll();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Unsaved Monitor');
  expect(await nameNode.evaluate(input => input === document.activeElement && input.selectionStart === 2 && input.selectionEnd === 8)).toBe(true);
  expect(await panel.evaluate(node => node === document.getElementById('inline-panels'))).toBe(true);
  expect(await selectedNode.evaluate(node => node.isConnected && node.getAttribute('aria-pressed') === 'true')).toBe(true);
  await expect(page.locator('.history').first().locator('[aria-pressed="true"]')).toHaveAttribute('data-date', selectedDate);
  await expect(page.locator('.history-detail').first()).toContainText('2 successes');

  const trigger = page.getByLabel('Actions for Other', { exact: true });
  await trigger.focus();
  await trigger.press('ArrowDown');
  const edit = page.getByRole('button', { name: 'Edit Other', exact: true });
  const menuNode = await trigger.locator('..').elementHandle();
  const editNode = await edit.elementHandle();
  const scroll = await page.evaluate(() => scrollY);
  data.monitors[1].maintenance = null;
  data.monitors[1].published = false;
  await poll();
  await expect(edit).toBeFocused();
  expect(await editNode.evaluate(node => node === document.activeElement)).toBe(true);
  expect(await menuNode.evaluate(node => node.open && node.isConnected)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await expect(name).toHaveValue('Unsaved Monitor');
  // Latest-snapshot actions still dismiss the retained menu and focus the editor.
  await page.getByRole('button', { name: 'Declare Maintenance Other', exact: true }).click();
  const end = page.locator('#maintenance-end');
  await end.fill('2030-11-16T12:30');
  const endNode = await end.elementHandle();
  data.monitors.unshift({ ...structuredClone(data.monitors[0]), id: 'new', name: 'Inserted' });
  await poll();
  await expect(end).toBeFocused();
  await expect(end).toHaveValue('2030-11-16T12:30');
  expect(await endNode.evaluate(node => node === document.activeElement)).toBe(true);
  await expect(page.locator('#maintenance')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Page name', { exact: true }).fill('Draft page');
  const webhook = page.getByLabel('HTTPS webhook URL', { exact: true });
  await webhook.fill('https://draft.example');
  await webhook.evaluate(input => input.setSelectionRange(8, 13));
  const webhookNode = await webhook.elementHandle();
  data.pageName = 'Remote page'; data.webhookUrl = 'https://remote.example';
  const response = page.waitForResponse('http://irisbeat.test/api/operator');
  await page.clock.runFor(60000); await response;
  await expect(webhook).toBeFocused();
  await expect(webhook).toHaveValue('https://draft.example');
  await expect(page.getByLabel('Page name', { exact: true })).toHaveValue('Draft page');
  expect(await webhookNode.evaluate(node => node === document.activeElement && node.selectionStart === 8 && node.selectionEnd === 13)).toBe(true);
  await page.getByRole('button', { name: 'Monitors', exact: true }).click();
  await expect(end).toHaveValue('2030-11-16T12:30');
});

test('reader downgrade and sign-out clear Settings, inline and Heartbeat values after polling', async ({ page }) => {
  await page.clock.install();
  const data = snapshot();
  data.hosted = true;
  data.webhookUrl = 'https://private.example';
  data.monitors[0].kind = 'heartbeat';
  await serve(page, data, true);
  await page.getByLabel('Actions for Website', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit Website', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.route('**/heartbeat-secret', route => route.fulfill({ json: { secret: 'ephemeral-credential' } }));
  await page.getByRole('button', { name: 'Rotate heartbeat secret', exact: true }).click();
  await expect(page.locator('#heartbeat-credential')).toContainText('ephemeral-credential');
  await page.getByLabel('Actions for Website', { exact: true }).click();
  await page.getByRole('button', { name: 'Replace Maintenance Website', exact: true }).click();
  await page.locator('#maintenance-end').fill('2030-11-16T12:30');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Page name', { exact: true }).fill('Private draft');
  await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('https://draft.example');
  data.permission = 'reader'; delete data.webhookUrl;
  const response = page.waitForResponse('http://irisbeat.test/api/operator');
  await page.clock.runFor(60000); await response;
  for (const id of ['pageName', 'webhookUrl', 'name', 'url', 'hostname', 'port', 'maintenance-end']) await expect(page.locator('#' + id)).toHaveValue('');
  await expect(page.locator('#heartbeat-path')).toBeEmpty();
  await expect(page.locator('#heartbeat-credential')).toBeEmpty();
  await expect(page.locator('summary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
  data.permission = 'editor'; data.webhookUrl = 'https://restored.example';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('https://restored.example');
  await page.getByRole('button', { name: 'Monitors', exact: true }).click();
  const rotate = async () => {
    await page.getByLabel('Actions for Website', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit Website', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Rotate heartbeat secret', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toContainText('ephemeral-credential');
  };
  await rotate();
  data.permission = 'reader'; delete data.webhookUrl;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#heartbeat-path')).toBeEmpty();
  await expect(page.locator('#heartbeat-credential')).toBeEmpty();
  data.permission = 'editor'; data.webhookUrl = 'https://restored.example';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await rotate();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#heartbeat-path')).toBeEmpty();
  await expect(page.locator('#heartbeat-credential')).toBeEmpty();
  for (const id of ['pageName', 'webhookUrl', 'name', 'url', 'hostname', 'port', 'maintenance-end']) await expect(page.locator('#' + id)).toHaveValue('');
  await expect(page.locator('#monitor-rows tr, #monitor-rows-after tr')).toHaveCount(0);
  await expect(page.getByLabel('Installation secret', { exact: true })).toBeFocused();
});

test('delayed End Maintenance returns focus from the closing draft to its Monitor', async ({ page }) => {
  const data = snapshot();
  await serve(page, data, true);
  const trigger = page.getByLabel('Actions for Website', { exact: true });
  await trigger.click();
  await page.getByRole('button', { name: 'Replace Maintenance Website', exact: true }).click();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/operator/monitors/website/maintenance', async route => {
    await pending;
    data.monitors[0].maintenance = null;
    await route.fulfill({ json: data });
  });
  await trigger.click();
  await page.getByRole('button', { name: 'End Maintenance Website', exact: true }).click();
  await page.locator('#maintenance-end').focus();
  release();
  await expect(page.locator('#maintenance')).toBeHidden();
  await expect(trigger).toBeFocused();
});
