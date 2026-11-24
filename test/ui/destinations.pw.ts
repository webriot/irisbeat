// SPDX-License-Identifier: AGPL-3.0-only
import { fulfillView } from './view-response';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { monitorAction } from './actions';

test('webhook ledger and inline Monitor selections require explicit opt-in', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const tag = 'destinations-' + Date.now();
  const discord = 'https://discord.com/api/webhooks/123/' + tag;
  const first = discord + '/slack';
  const second = 'https://alerts.example.invalid/' + tag + '/second';
  const replacement = discord + '-replacement/slack';
  const firstName = tag + ' First';
  const secondName = tag + ' Second';
  const renamed = tag + ' Renamed';
  const replacementName = tag + ' Replacement';
  const ledger = page.getByRole('list', { name: 'Notification destinations' });
  const snapshot = async () => (await request.get('/api/operator', { headers })).json();

  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/operator');
  await page.getByLabel('Installation secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add webhook' });
    const url = page.getByLabel('HTTPS webhook URL');
    const name = page.getByLabel('Destination name');
    for (const [address, label] of [[first, firstName], [second, secondName]]) {
      await add.focus();
      await page.keyboard.press('Enter');
      await expect(name).toBeFocused();
      await expect(name).toHaveAttribute('required', '');
      await name.fill(label);
      const editor = page.getByRole('form', { name: 'Add webhook', exact: true });
      await expect(editor.getByLabel('HTTPS webhook URL')).toBeVisible();
      await expect(editor.getByRole('heading')).toHaveCount(0);
      await url.fill(address);
      await page.getByRole('button', { name: 'Save webhook' }).click();
      await expect(ledger.getByText(label, { exact: true })).toBeVisible();
      await expect(ledger.getByText(address, { exact: true })).toHaveCount(0);
      await expect(add).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    await page.getByRole('button', { name: 'New Monitor' }).click();
    await page.getByLabel('Monitor name', { exact: true }).fill(tag);
    await page.getByLabel('Check type').selectOption('heartbeat');
    await page.getByRole('button', { name: 'Save Monitor' }).click();
    await monitorAction(page, 'Edit ' + tag);
    const choices = page.getByRole('group', { name: 'Notification destinations' });
    const firstChoice = choices.getByRole('checkbox', { name: firstName, exact: true });
    const secondChoice = choices.getByRole('checkbox', { name: secondName, exact: true });
    await expect(firstChoice).not.toBeChecked();
    await expect(secondChoice).not.toBeChecked();
    await firstChoice.focus();
    await page.keyboard.press('Space');
    await secondChoice.check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Save Monitor' }).click();
    await monitorAction(page, 'Edit ' + tag);
    await expect(firstChoice).toBeChecked();
    await expect(secondChoice).toBeChecked();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Edit ' + firstName, exact: true }).click();
    await expect(name).toBeFocused();
    const editor = page.getByRole('form', { name: 'Edit webhook', exact: true });
    await expect(editor.getByLabel('HTTPS webhook URL')).toHaveValue(first);
    await expect(name).toHaveValue(firstName);
    const warning = editor.getByText(/clears its Monitor selections/);
    await expect(warning).toBeHidden();
    await url.fill(discord);
    await expect(warning).toBeHidden();
    await name.fill(secondName.toUpperCase());
    await editor.getByRole('button', { name: 'Save webhook' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'A destination with this name already exists' })).toBeVisible();
    await name.fill(renamed);
    await editor.getByRole('button', { name: 'Save webhook' }).click();
    const editRenamed = page.getByRole('button', { name: 'Edit ' + renamed, exact: true });
    await expect(editRenamed).toBeFocused();
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    await expect(choices.getByRole('checkbox', { name: renamed, exact: true })).toBeChecked();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await editRenamed.click();
    await name.fill(replacementName);
    await url.fill(replacement);
    await expect(warning).toBeVisible();
    await url.fill(first);
    await expect(warning).toBeHidden();
    await url.fill(replacement);
    await editor.getByRole('button', { name: 'Save webhook' }).click();
    await expect(ledger.getByText(replacementName, { exact: true })).toBeVisible();
    await expect(editRenamed).toHaveCount(0);
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    await expect(choices.getByRole('checkbox', { name: replacementName, exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Remove ' + replacementName, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove ' + replacementName, exact: true })).toBeFocused();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remove ' + replacementName, exact: true }).click();
    await expect(ledger.getByText(replacementName, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    await expect(firstChoice).toHaveCount(0);
    await expect(secondChoice).toBeChecked();
    await secondChoice.uncheck();
    await page.getByRole('button', { name: 'Save Monitor' }).click();
    await monitorAction(page, 'Edit ' + tag);
    await expect(secondChoice).not.toBeChecked();
    expect((await snapshot()).monitors.find((monitor: { name: string }) => monitor.name === tag).destinationIds).toEqual([]);
  } finally {
    const data = await snapshot();
    for (const monitor of data.monitors.filter((monitor: { name: string }) => monitor.name === tag)) {
      await request.delete('/api/operator/monitors/' + monitor.id, { headers });
    }
    for (const destination of data.destinations.filter((item: { url: string }) => item.url.includes(tag))) {
      await request.delete('/api/operator/destinations/' + destination.id, { headers });
    }
  }
});

test('Monitor selection drafts survive refresh and save failure alongside concurrent selections', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const tag = 'concurrent-' + Date.now();
  const names = ['local', 'remote', 'unseen'].map(part => tag + '-' + part);
  const ids: string[] = [];
  for (const name of names) {
    const url = 'https://alerts.example.invalid/' + name;
    const response = await request.post('/api/operator/destinations', { headers, data: { url, name } });
    expect(response.status()).toBe(201);
    ids.push((await response.json()).destinations.find((destination: { url: string }) => destination.url === url).id);
  }
  const created = await request.post('/api/operator/monitors', { headers, data: { name: tag, kind: 'heartbeat' } });
  const id = (await created.json()).monitors.find((monitor: { name: string }) => monitor.name === tag).id;
  const path = '/api/operator/monitors/' + id;
  try {
    await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await monitorAction(page, 'Edit ' + tag);
    const [local, remote, unseen] = names.map(name => page.getByRole('checkbox', { name, exact: true }));
    const name = page.getByLabel('Monitor name', { exact: true });
    await name.fill(tag + ' draft');
    await local.check();
    await local.focus();
    expect((await request.patch(path, { headers, data: { destinationIds: [ids[1]] } })).ok()).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(remote).toBeChecked();
    await expect(local).toBeChecked();
    await expect(local).toBeFocused();
    await expect(name).toHaveValue(tag + ' draft');

    const save = page.getByRole('button', { name: 'Save Monitor' });
    await page.route('**' + path, route => route.fulfill({ status: 503, json: { error: 'Save unavailable' } }), { times: 1 });
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Save unavailable' })).toBeVisible();
    await expect(local).toBeChecked();
    await expect(name).toHaveValue(tag + ' draft');
    await expect(save).toBeFocused();

    // Another editor changes two checkboxes without this tab receiving an invalidation.
    expect((await request.patch(path, { headers, data: { destinationIds: [ids[2]] } })).ok()).toBe(true);
    await expect(unseen).not.toBeChecked();
    await save.click();
    await monitorAction(page, 'Edit ' + tag + ' draft');
    await expect(local).toBeChecked();
    await expect(remote).not.toBeChecked();
    await expect(unseen).toBeChecked();
  } finally {
    await request.delete(path, { headers });
    for (const id of ids) await request.delete('/api/operator/destinations/' + id, { headers });
  }
});

test('a rejected Monitor save refreshes a destination removed during Live updates', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const tag = 'removed-destination-' + Date.now();
  const url = 'https://alerts.example.invalid/' + tag;
  const created = await request.post('/api/operator/destinations', { headers, data: { url } });
  expect(created.status()).toBe(201);
  const destination = (await created.json()).destinations.find((item: { url: string }) => item.url === url);
  const monitor = await request.post('/api/operator/monitors', { headers, data: { name: tag, kind: 'heartbeat' } });
  expect(monitor.status()).toBe(201);
  const id = (await monitor.json()).monitors.find((item: { name: string }) => item.name === tag).id;
  const path = '/api/operator/monitors/' + id;
  let release: (() => void) | undefined;
  let live!: WebSocketRoute;
  try {
    // Keep unrelated changes from parallel tests out of this single-invalidation race.
    await page.routeWebSocket('**/api/operator/events/v2', socket => {
      live = socket;
      socket.onMessage(message => { if (message !== 'ack') socket.send('authorized'); });
    });
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#updates-mode')).toBeHidden();
    await expect(page.locator('#retry')).toBeEnabled();
    await monitorAction(page, 'Edit ' + tag);
    const choice = page.getByRole('checkbox', { name: destination.name, exact: true });
    const name = page.getByLabel('Monitor name', { exact: true });
    const save = page.getByRole('button', { name: 'Save Monitor' });
    await name.fill(tag + ' draft');
    await choice.check();

    await page.route('**/api/operator/partials/destinations?*', async route => {
      await new Promise<void>(resolve => { release = resolve; });
      await route.continue();
    }, { times: 1 });
    expect((await request.delete('/api/operator/destinations/' + destination.id, { headers })).ok()).toBe(true);
    live.send(JSON.stringify({ type: 'changed', revision: 1, scopes: ['destinations'] }));
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(choice).toBeChecked();
    const rejected = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PATCH');
    await save.click();
    expect((await rejected).status()).toBe(400);
    await expect(save).toBeFocused();
    release!();

    await expect(choice).toHaveCount(0);
    await expect(name).toHaveValue(tag + ' draft');
    await expect(save).toBeFocused();
    const retried = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'PATCH');
    await save.click();
    expect((await retried).status()).toBe(200);
    await expect(page.getByRole('cell', { name: tag + ' draft', exact: true })).toBeVisible();
  } finally {
    release?.();
    await request.delete(path, { headers });
    await request.delete('/api/operator/destinations/' + destination.id, { headers });
  }
});

test('Settings preserves webhook and page drafts across independent saves, failures and ledger refresh', async ({ page }) => {
  const original = 'https://example.invalid/original';
  const current = 'https://example.invalid/current';
  const draft = 'https://example.invalid/draft';
  let data = {
    pageName: 'Status',
    destinations: [{ id: 'original', name: 'Original webhook', channel: 'webhook', url: original }],
    monitors: [],
    incidents: [],
  };
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } }); });
  await page.route('**/api/operator', route => {
    if (route.request().method() === 'PUT') data = { ...data, pageName: route.request().postDataJSON().pageName };
    return fulfillView(route, { json: data });
  });
  await page.route('**/api/operator/destinations/original', route => route.fulfill({ status: 503, json: { error: 'Save unavailable' } }));
  await page.goto('/operator');
  await page.getByLabel('Installation secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const originalAction = page.getByRole('button', { name: 'Edit Original webhook', exact: true });
  const pageName = page.getByLabel('Page name');
  const url = page.getByLabel('HTTPS webhook URL');
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await originalAction.focus();
  data.destinations = [...data.destinations, { id: 'current', name: 'Current webhook', channel: 'webhook', url: current }];
  await refresh();
  const currentAction = page.getByRole('button', { name: 'Edit Current webhook', exact: true });
  await expect(currentAction).toBeVisible();
  await expect(originalAction).toBeFocused();
  await originalAction.click();
  const name = page.getByLabel('Destination name');
  await name.fill('Draft webhook');
  await url.fill(draft);
  await pageName.fill('Saved page');
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(url).toHaveValue(draft);
  await expect(name).toHaveValue('Draft webhook');

  await pageName.fill('Page draft');
  const save = page.getByRole('button', { name: 'Save webhook', exact: true });
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Save unavailable' })).toBeVisible();
  await expect(save).toBeFocused();
  await expect(url).toHaveValue(draft);
  await expect(name).toHaveValue('Draft webhook');
  await expect(pageName).toHaveValue('Page draft');

  data.destinations = data.destinations.filter(destination => destination.id !== 'original');
  await url.focus();
  await refresh();
  await expect(originalAction).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(url).toBeFocused();
  await expect(url).toHaveValue(draft);
  await expect(name).toHaveValue('Draft webhook');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('button', { name: 'Add webhook' }).click();
  await name.fill('Saved webhook');
  await url.fill(draft);
  await page.route('**/api/operator/destinations', route => {
    data.destinations.push({ id: 'saved', channel: 'webhook', ...route.request().postDataJSON() });
    return fulfillView(route, { status: 201, json: data });
  });
  await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Saved webhook', exact: true })).toBeVisible();
  await expect(pageName).toHaveValue('Page draft');
});

test('Settings distinguishes provider acceptance, retries and terminal failure', async ({ page }) => {
  const at = Date.UTC(2026, 10, 18, 9, 30);
  await page.route('**/api/operator', route => fulfillView(route, { json: {
    pageName: 'Status', monitors: [], incidents: [],
    destinations: [
      { id: 'ok', name: 'Accepted', channel: 'webhook', url: 'https://alerts.example/ok', latestSubmission: { status: 'accepted', at } },
      { id: 'retry', name: 'Retrying', channel: 'webhook', url: 'https://alerts.example/retry', latestSubmission: { status: 'retrying', reason: 'rate_limited', at } },
      { id: 'failed', name: 'Failed', channel: 'webhook', url: 'https://alerts.example/failed', latestSubmission: { status: 'failed', reason: 'attempts_exhausted', at } },
    ],
  } }));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/operator');
  await page.getByLabel('Installation secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const ledger = page.getByRole('list', { name: 'Notification destinations' });
  const accepted = ledger.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Accepted', exact: true }) });
  await expect(accepted.getByText('Submission accepted', { exact: true })).toBeVisible();
  await expect(accepted.locator('time')).toHaveAttribute('datetime', new Date(at).toISOString());
  await expect(ledger.getByText('Submission failed · Retrying · Provider rate limit', { exact: true })).toBeVisible();
  await expect(ledger.getByText('Submission failed · Retry limit reached', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
