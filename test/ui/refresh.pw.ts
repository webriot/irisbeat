// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { monitorAction } from './actions';

// Snapshot reconciliation runs with transport unavailable; live transport has its own browser coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
});

for (const kind of ['http', 'tcp', 'heartbeat']) {
test(kind + ' retry preserves rows, drafts, and focus while reconciling collection changes', async ({ page }) => {
  const data = { pageName: 'Original', webhookUrl: 'https://example.com/hook', monitors: [
    { id: 'web', name: 'Website', kind, url: 'https://example.com', state: 'up', published: true, history: null as null | { percentage: number; days: { date: string; state: string; successes: number; failures: number; maintenance: number }[] } },
  ], incidents: [] };
  let failure = false;
  await page.route('**/api/operator', route => route.fulfill(failure ? { status: 503, json: { error: 'Unavailable' } } : { json: data }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await monitorAction(page, 'Edit Website');
  await page.locator('#name').fill('Draft');
  if (kind === 'http') await page.locator('#url').fill('https://draft.example.com');
  if (kind === 'tcp') { await page.locator('#hostname').fill('draft.internal'); await page.locator('#port').fill('8443'); }
  await page.locator('#intervalSeconds-unit').selectOption('minutes');
  await page.locator('#intervalSeconds').fill('2.5');
  await monitorAction(page, 'Maintenance Website');
  await page.locator('#maintenance-end').fill('2027-01-01T12:00');
  await page.keyboard.press('Escape');
  await page.locator('#settings-button').click();
  await page.locator('#pageName').fill('Draft page');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.locator('#destination-address').fill('https://example.com/draft');
  const row = await page.locator('#monitor-rows tr').first().elementHandle();
  data.pageName = 'Remote';
  failure = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#stale')).toBeVisible();
  failure = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#stale')).toBeHidden();
  await expect(page.locator('#pageName')).toHaveValue('Draft page');
  await expect(page.locator('#intervalSeconds-unit')).toHaveValue('minutes');
  await expect(page.locator('#intervalSeconds')).toHaveValue('2.5');
  await expect(page.locator('#maintenance-end')).toHaveValue('2027-01-01T12:00');
  if (kind === 'http') await expect(page.locator('#url')).toHaveValue('https://draft.example.com');
  if (kind === 'tcp') { await expect(page.locator('#hostname')).toHaveValue('draft.internal'); await expect(page.locator('#port')).toHaveValue('8443'); }
  await expect(page.locator('#destination-address')).toHaveValue('https://example.com/draft');
  expect(await row!.evaluate(node => node === document.querySelector('#monitor-rows tr'))).toBe(true);
  data.pageName = 'Saved page';
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(page.locator('#pageName')).toHaveValue('Saved page');
  await expect(page.locator('#destination-address')).toHaveValue('https://example.com/draft');
  await expect(page.locator('#name')).toHaveValue('Draft');
  await page.locator('#back-monitors').click();
  data.monitors[0].state = 'down';
  data.monitors[0].history = { percentage: 0, days: [{ date: '2026-11-16', state: 'down', successes: 0, failures: 1, maintenance: 0 }] };
  const monitorForm = await page.locator('#configuration').elementHandle();
  const maintenance = await page.locator('#maintenance').elementHandle();
  const moves = await page.evaluateHandle(() => {
    const drafts = [document.querySelector('#configuration')!, document.querySelector('#maintenance')!];
    const removed: Node[] = [];
    new MutationObserver(records => records.forEach(record => record.removedNodes.forEach(node => {
      if (drafts.some(draft => node === draft || node.contains(draft))) removed.push(node);
    }))).observe(document.querySelector('#workspace')!, { childList: true, subtree: true });
    return removed;
  });
  await page.locator('#name').focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#monitor-rows .status')).toHaveText('Unavailable');
  await expect(page.locator('#name')).toBeFocused();
  await expect(page.locator('#configuration')).toBeVisible();
  await expect(page.locator('#configuration').locator('..')).toHaveAttribute('id', 'history-web');
  await monitorAction(page, 'Maintenance Website');
  await page.locator('#maintenance-end').fill('2027-01-01T12:00');
  data.monitors[0].history = null;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#monitor-rows .history')).toHaveCount(0);
  await expect(page.locator('#maintenance-end')).toBeFocused();
  await expect(page.locator('#maintenance')).toHaveAttribute('data-monitor-id', 'web');
  expect(await monitorForm!.evaluate(node => node === document.querySelector('#configuration'))).toBe(true);
  expect(await maintenance!.evaluate(node => node === document.querySelector('#maintenance'))).toBe(true);
  expect(await moves.evaluate(removed => removed.length)).toBe(0);
  data.monitors = [];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#name')).toHaveValue('Draft');
  await expect(page.locator('#configuration').locator('..')).toHaveAttribute('id', 'new-monitor-panel');
  await expect(page.locator('#maintenance')).toBeVisible();
  await expect(page.locator('#configuration')).toContainText('This Monitor was deleted.');
  await expect(page.getByRole('button', { name: 'Save Monitor', exact: true })).toBeDisabled();
  await expect(page.locator('#save-maintenance')).toBeDisabled();
  await expect(page.locator('#maintenance-end')).toHaveValue('2027-01-01T12:00');
});
}

for (const path of ['/', '/operator']) {
  test(`${path} polls only while visible, recovers from failures and rejects stale responses`, async ({ page, request, baseURL }) => {
    const data = { pageName: 'Refresh status', paused: false, webhookUrl: null, monitors: [
      { id: 'one', name: 'First', kind: 'http', url: 'https://example.com', state: 'up', published: true,
        history: { percentage: 100, days: [
          { date: '2026-11-15', state: 'up', successes: 1, failures: 0, maintenance: 0 },
          { date: '2026-11-16', state: 'up', successes: 1, failures: 0, maintenance: 0 },
        ] } },
    ], incidents: [] as { monitorId: string; openedAt: number; closedAt: number | null }[] };
    await page.clock.install();
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });
    if (path === '/') await page.route(baseURL! + '/', async route => {
      const response = await request.post('/__ui/status', { data });
      await route.fulfill({ response });
    });
    let reads = 0;
    let failure = false;
    let hold: (() => Promise<void>) | undefined;
    const api = path === '/' ? '**/api/status' : '**/api/operator';
    await page.route(api, async route => {
      ++reads;
      if (hold) {
        const deferred = hold; hold = undefined;
        const obsolete = structuredClone(data); obsolete.pageName = 'Obsolete'; obsolete.monitors[0].name = 'Obsolete';
        await deferred(); return route.fulfill({ json: obsolete });
      }
      await route.fulfill(failure ? { status: 503, json: { error: 'Unavailable' } } : { json: data });
    });
    await page.goto(path);
    if (path === '/operator') {
      await page.locator('#secret').fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
    const row = await page.locator(path === '/' ? '.ledger article' : '#monitor-rows tr').first().elementHandle();
    const day = page.locator('[data-date="2026-11-15"]');
    await day.click();
    await page.clock.fastForward(60000);
    await expect.poll(() => reads).toBe(path === '/' ? 1 : 2);
    await expect(day).toBeFocused();
    expect(await row!.evaluate(node => node.isConnected)).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const before = reads;
    await page.clock.fastForward(180000);
    expect(reads).toBe(before);
    failure = true;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#stale')).toBeVisible();
    await expect(day).toBeFocused();
    failure = false;
    data.paused = true;
    data.monitors[0].state = 'paused';
    data.monitors[0].name = 'Renamed';
    data.monitors[0].published = false;
    data.incidents.push({ monitorId: 'one', openedAt: Date.parse('2026-11-16T10:00Z'), closedAt: null });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('#stale')).toBeHidden();
    await expect(page.locator(path === '/' ? '.ledger' : '#monitor-rows').getByText('Renamed', { exact: true })).toBeVisible();
    if (path === '/operator') {
      await expect(page.getByRole('button', { name: 'Publish Renamed', exact: true })).toBeVisible();
    }
    await expect(page.locator('[data-date="2026-11-15"]')).toHaveAttribute('aria-current', 'true');
    expect(await row!.evaluate(node => node.isConnected)).toBe(true);
    let release!: () => void;
    hold = () => new Promise<void>(resolve => { release = resolve; });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => !!release).toBe(true);
    data.monitors.push({ ...data.monitors[0], id: 'two', name: 'Second' });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const obsolete = page.waitForResponse(async response => response.url().includes('/api/') && (await response.text()).includes('Obsolete'));
    release();
    await obsolete;
    await expect(page.getByText('Obsolete', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Second', { exact: true })).toBeVisible();
    const secondDay = page.locator('.history').last().locator('[data-date="2026-11-15"]');
    await secondDay.focus();
    data.monitors.shift();
    data.incidents = [];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText('Renamed', { exact: true })).toHaveCount(0);
    await expect(secondDay).toBeFocused();
    await expect(page.locator('.incident time')).toHaveCount(0);
  });
}

test('authorization loss clears private drafts and ignores an earlier in-flight snapshot', async ({ page }) => {
  const data = { pageName: 'Private page', webhookUrl: 'https://example.com/private-hook', monitors: [
    { id: 'private', name: 'Private monitor', kind: 'tcp', hostname: 'private.internal', port: 443, state: 'up', published: false, history: null },
  ], incidents: [] };
  await page.route('**/api/operator', route => route.fulfill({ json: data }));
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await monitorAction(page, 'Edit Private monitor');
  await page.locator('#settings-button').click();
  let release!: () => void;
  await page.route('**/api/operator', async route => {
    if (!release) { await new Promise<void>(resolve => { release = resolve; }); return route.fulfill({ json: data }); }
    return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(page.locator('#login')).toBeVisible();
  release();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#hostname')).toHaveValue('');
  await expect(page.locator('#destination-address')).toHaveValue('');
  await expect(page.locator('#monitor-rows')).toBeEmpty();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('ui-test-secret');
});

for (const newerStatus of [200, 503]) {
  test(`older current-session 401 signs out after newer ${newerStatus}`, async ({ page }) => {
    const data = { pageName: 'Private', webhookUrl: 'https://example.com/private' as string | null, monitors: [], incidents: [] };
    await page.route('**/api/operator', route => route.fulfill({ json: data }));
    await page.goto('/operator');
    await page.locator('#secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#editor')).toBeVisible();
    await page.locator('#settings-button').click();
    let release!: () => void;
    await page.route('**/api/operator', async route => {
      if (!release) {
        await new Promise<void>(resolve => { release = resolve; });
        return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      }
      return route.fulfill({ status: newerStatus, json: newerStatus === 200 ? { ...data, pageName: 'Newer' } : { error: 'Unavailable' } });
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => !!release).toBe(true);
    const newerResponse = page.waitForResponse(response => response.url().endsWith('/api/operator'));
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await (await newerResponse).finished();
    if (newerStatus === 503) await expect(page.locator('#message')).toHaveText('Unavailable');
    else await expect(page.locator('#pageName')).toHaveValue('Newer');
    release();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#destination-address')).toHaveValue('');
    await expect(page.locator('#editor')).toBeHidden();
  });
}

for (const status of [200, 401, 503]) {
  test(`previous-session ${status} cannot alter a newer sign-in with the same credential`, async ({ page }) => {
    const data = { pageName: 'Previous session', destinations: [{ id: 'hook', url: 'https://example.com/previous', channel: 'webhook' }], monitors: [], incidents: [] };
    await page.route('**/api/operator', route => route.fulfill({ json: data }));
    await page.goto('/operator');
    await page.locator('#secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#editor')).toBeVisible();
    let release!: () => void;
    await page.route('**/api/operator', async route => {
      if (!release) {
        const previous = structuredClone(data);
        await new Promise<void>(resolve => { release = resolve; });
        return route.fulfill({ status, json: status === 200 ? previous : { error: 'Previous session error' } });
      }
      return route.fulfill({ json: data });
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => !!release).toBe(true);
    await page.locator('#logout').click();
    data.pageName = 'New session'; data.destinations[0].url = 'https://example.com/new';
    await page.locator('#secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#pageName')).toHaveValue('New session');
    const response = page.waitForResponse(response => response.url().endsWith('/api/operator'));
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('#editor')).toBeVisible();
    await expect(page.locator('#pageName')).toHaveValue('New session');
    await expect(page.locator('#destination-rows')).toHaveText(/example\.com\/new/);
    await expect(page.locator('#stale')).toBeHidden();
    await expect(page.locator('#message')).toBeEmpty();
  });
}

test('pristine Settings refresh and page saves reset the draft baseline', async ({ page }) => {
  const data = { pageName: 'Original', monitors: [], incidents: [], destinations: [{ id: 'hook', url: 'https://example.com/original', channel: 'webhook' }] };
  await page.route('**/api/operator', route => route.fulfill({ json: data }));
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#settings-button').click();
  const pageName = page.getByLabel('Page name');
  await expect(pageName).toHaveValue('Original');
  data.pageName = 'Remote';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(pageName).toHaveValue('Remote');
  await expect(pageName).toBeFocused();
  await pageName.fill('Draft page');
  data.pageName = 'Remote two';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(pageName).toHaveValue('Draft page');
  data.pageName = 'Saved page';
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(pageName).toHaveValue('Saved page');
  data.pageName = 'After page save';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(pageName).toHaveValue('After page save');
  await page.locator('#pageName').fill('Temporary draft');
  await page.locator('#pageName').fill('After page save');
  data.pageName = 'After revert';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#pageName')).toHaveValue('After revert');
});

for (const dirty of [false, true]) {
  test(`reader downgrade clears ${dirty ? 'draft' : 'saved'} webhook destinations before promotion`, async ({ page }) => {
    const privateUrl = 'https://example.com/private';
    const destination = { id: 'hook', url: privateUrl, channel: 'webhook' };
    const data = { pageName: 'Hosted', hosted: true, permission: 'editor', destinations: [destination], monitors: [
      { id: 'hosted', name: 'Hosted Monitor', kind: 'heartbeat', state: 'up', destinationIds: ['hook'] },
    ], incidents: [] };
    await page.route('**/api/operator', route => route.fulfill({ json: data }));
    await page.goto('/operator');
    await page.locator('#secret').fill('ui-editor');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await monitorAction(page, 'Edit Hosted Monitor');
    await expect(page.getByRole('checkbox', { name: privateUrl })).toBeChecked();
    await page.locator('#settings-button').click();
    const replace = page.getByRole('button', { name: 'Replace ' + privateUrl, exact: true });
    await expect(replace).toBeVisible();
    if (dirty) {
      await replace.click();
      await page.getByLabel('HTTPS webhook URL').fill(privateUrl + '-draft');
    }
    data.permission = 'reader'; data.destinations = [];
    if (dirty) {
      await page.route('**/api/operator/destinations/hook', route => route.fulfill({ status: 403, json: { error: 'Forbidden' } }));
      await page.getByRole('button', { name: 'Replace webhook', exact: true }).click();
    } else {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    }
    await expect(page.locator('#destination-rows')).toBeEmpty();
    await expect(page.locator('#destination-choices')).toBeEmpty();
    await expect(page.locator('#destination-address')).toHaveValue('');
    await expect(page.getByRole('heading', { name: 'Monitors' })).toBeFocused();
    data.permission = 'editor';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#settings-button').click();
    await expect(page.getByText('No destinations', { exact: true }).filter({ visible: true })).toBeVisible();
    data.destinations = [{ ...destination, id: 'new', url: 'https://example.com/newly-authorized' }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'Replace https://example.com/newly-authorized' })).toBeVisible();
  });
}

test('Maintenance changes preserve focused publication actions and keyboard behavior', async ({ page }) => {
  const data = { pageName: 'Actions', webhookUrl: null, monitors: [
    { id: 'one', name: 'One', kind: 'http', url: 'https://example.com', state: 'up', published: true, maintenance: null as { endsAt: number } | null },
  ], incidents: [] };
  const mutations: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/operator', route => route.fulfill({ json: data }));
  await page.route('**/api/operator/monitors/**', async route => {
    mutations.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    if (route.request().method() === 'PATCH') data.monitors[0].published = route.request().postDataJSON().published;
    await route.fulfill({ json: data });
  });
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const actions = page.getByRole('group', { name: 'Actions One', exact: true });
  const unpublish = page.getByRole('button', { name: 'Unpublish One', exact: true });
  const node = await unpublish.elementHandle();
  await unpublish.focus();
  data.monitors[0].maintenance = { endsAt: Date.now() + 3600000 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(actions.getByRole('button')).toHaveCount(4);
  await expect(unpublish).toBeFocused();
  expect(await node!.evaluate(node => node === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Publish One', exact: true })).toBeVisible();
  expect(mutations).toEqual([{ method: 'PATCH', path: '/api/operator/monitors/one', body: { published: false } }]);
  const publish = page.getByRole('button', { name: 'Publish One', exact: true });
  const publishNode = await publish.elementHandle();
  await publish.focus();
  data.monitors[0].maintenance = null;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(actions.getByRole('button')).toHaveCount(4);
  await expect(publish).toBeFocused();
  expect(await publishNode!.evaluate(node => node === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(unpublish).toBeVisible();
  expect(mutations[1]).toEqual({ method: 'PATCH', path: '/api/operator/monitors/one', body: { published: true } });
});


test('deleting an edited Monitor preserves its editor and closed Maintenance draft', async ({ page }) => {
  const data = { pageName: 'Delete', webhookUrl: null, monitors: [
    { id: 'one', name: 'One', kind: 'http', url: 'https://example.com', state: 'up', published: true, history: null },
  ], incidents: [] };
  await page.route('**/api/operator', route => route.fulfill({ json: data }));
  await page.route('**/api/operator/monitors/one', async route => {
    expect(route.request().method()).toBe('DELETE');
    data.monitors = [];
    await route.fulfill({ json: data });
  });
  await page.goto('/operator');
  await page.locator('#secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await monitorAction(page, 'Edit One');
  await page.locator('#name').fill('Retained draft');
  await monitorAction(page, 'Maintenance One');
  await page.locator('#maintenance-end').fill('2027-01-01T12:00');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await monitorAction(page, 'Delete One');
  await expect(page.locator('#message')).toHaveText('Deleted');
  await expect(page.locator('#configuration')).toBeVisible();
  await expect(page.locator('#name')).toHaveValue('Retained draft');
  await expect(page.locator('#monitor-deleted')).toBeVisible();
  await expect(page.locator('#save-monitor')).toBeDisabled();
  await expect(page.locator('#maintenance-end')).toHaveValue('2027-01-01T12:00');
  await expect(page.locator('#maintenance-dialog')).toBeHidden();
  await expect(page.locator('#new-monitor')).toBeFocused();
});
