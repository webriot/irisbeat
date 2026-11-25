// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type WebSocketRoute } from '@playwright/test';

test('Operator Settings lists, issues, copies and revokes API keys', async ({ page, context, request, baseURL }) => {
  const path = '/api/operator/api-keys';
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const name = 'Dashboard ' + crypto.randomUUID();
  const replacement = name + ' replacement';
  const initial = await request.post(path, { headers, data: { name, role: 'read' } });
  expect(initial.status()).toBe(201);
  const previous = await initial.json();
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let live: WebSocketRoute | undefined;
    await page.routeWebSocket('**/api/operator/events/v2', socket => {
      socket.onMessage(message => {
        if (message === 'ack') return;
        live = socket;
        socket.send('authorized');
      });
    });
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    const inventory = page.getByRole('list', { name: 'API keys' });
    const oldKey = inventory.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Revoke ' + name, exact: true }) });
    await expect(oldKey).toContainText('Read');
    await expect(oldKey).toContainText('No expiry');
    await expect(page.locator('body')).not.toContainText(previous.secret);
    const newKey = page.getByRole('button', { name: 'New API key' });
    await newKey.press('Enter');
    const keyName = page.getByRole('textbox', { name: 'Key name' });
    await expect(keyName).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Role', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(newKey).toBeFocused();

    await newKey.press('Enter');
    await keyName.fill(replacement);
    await page.getByLabel('Role', { exact: true }).selectOption('write');
    await page.getByLabel('Expires on').fill('2099-01-31');
    const issuedResponse = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Issue API key' }).press('Enter');
    const issued = await (await issuedResponse).json();
    const disclosure = page.getByRole('dialog', { name: 'Copy your API key' });
    const secret = page.getByLabel('API key secret');
    await expect(secret).toHaveValue(issued.secret);
    const copy = disclosure.getByRole('button', { name: 'Copy key' });
    await expect(copy).toBeFocused();
    await copy.press('Enter');
    await expect(disclosure.getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(async () => {
      const value = await navigator.clipboard.readText();
      await navigator.clipboard.writeText('');
      return value;
    })).toBe(issued.secret);
    await disclosure.getByRole('button', { name: 'Done' }).press('Enter');
    await expect(newKey).toBeFocused();
    await expect(secret).toHaveValue('');
    const newRow = inventory.getByRole('listitem').filter({ hasText: replacement });
    await expect(newRow).toContainText('Write');
    await expect(newRow.getByText('Expires', { exact: false }).locator('time')).toHaveAttribute('datetime', '2099-01-31T23:59:59.999Z');
    const revoke = oldKey.getByRole('button', { name: 'Revoke ' + name, exact: true });
    await revoke.press('Enter');
    const revokeDialog = page.getByRole('dialog', { name: 'Revoke ' + name + '?' });
    await expect(revokeDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(revoke).toBeFocused();
    await revoke.press('Enter');
    await revokeDialog.getByRole('button', { name: 'Revoke key' }).press('Enter');
    await expect(oldKey).toHaveCount(0);
    await expect(newRow).toBeVisible();
    await expect(newKey).toBeFocused();

    await newKey.press('Enter');
    await keyName.fill(name + ' session loss');
    await page.getByRole('button', { name: 'Issue API key' }).press('Enter');
    await expect(disclosure).toBeVisible();
    await expect.poll(() => !!live).toBe(true);
    await page.route('**/api/operator/partials/page?*', route => route.fulfill({ status: 401 }));
    live!.send(JSON.stringify({ type: 'changed', revision: 1, scopes: ['page'] }));
    await expect(page.getByLabel('Installation secret')).toBeFocused();
    await expect(disclosure).toBeHidden();
    await expect(secret).toHaveValue('');
    await expect(inventory.getByRole('listitem', { includeHidden: true })).toHaveCount(0);

    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(newRow).toBeVisible();
    await expect(oldKey).toHaveCount(0);
    await expect(secret).toHaveValue('');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Installation secret')).toBeFocused();
    await expect(secret).toHaveValue('');

    const hosted = new URL('/operator', baseURL);
    hosted.hostname = 'localhost';
    const hostedKeyRequests: string[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname.startsWith(path)) hostedKeyRequests.push(req.url());
    });
    await page.goto(hosted.href);
    await page.getByLabel('Access token').fill('ui-editor');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Notification destinations' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API keys', includeHidden: true })).toHaveCount(0);
    expect(hostedKeyRequests).toEqual([]);
  } finally {
    const { keys } = await (await request.get(path, { headers })).json() as { keys: { id: string; name: string }[] };
    for (const key of keys.filter(key => key.name.startsWith(name))) await request.delete(path + '/' + key.id, { headers });
  }
});

test('Operator Settings reconciles uncertain issuance and concurrent revocation', async ({ page, request }) => {
  const path = '/api/operator/api-keys';
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const name = 'Recovery ' + crypto.randomUUID();
  const data = { name, role: 'read' };
  const initial = await request.post(path, { headers, data });
  expect(initial.status()).toBe(201);
  const original = await initial.json();
  let loseResponse!: () => void;
  const lostResponse = new Promise<void>(resolve => { loseResponse = resolve; });
  let finishRevoke!: () => void;
  const revoking = new Promise<void>(resolve => { finishRevoke = resolve; });
  let remainingRefreshFailures = 0;
  let posts = 0;
  await page.route('**' + path, async route => {
    if (route.request().method() === 'POST') {
      posts++;
      const result = await route.fetch();
      expect(result.status()).toBe(201);
      expect((await request.post(path, { headers, data })).status()).toBe(201);
      await lostResponse;
      remainingRefreshFailures = 2;
      await route.abort('timedout');
    } else if (remainingRefreshFailures) {
      remainingRefreshFailures--;
      await route.fulfill({ status: 503 });
    } else {
      await route.continue();
    }
  });
  const revokePath = path + '/' + original.key.id;
  await page.route('**' + revokePath, async route => {
    await revoking;
    await route.continue();
  });
  try {
    await page.goto('/operator');
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const newKey = page.getByRole('button', { name: 'New API key' });
    await newKey.click();
    const issue = page.getByRole('dialog', { name: 'New API key' });
    await issue.getByLabel('Key name').fill(name);
    await issue.getByRole('button', { name: 'Issue API key' }).click();
    await expect(issue.getByRole('status')).toHaveText('Issuing API key…');
    await expect(issue.getByRole('status')).toBeFocused();
    await expect(issue.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    for (const label of ['Key name', 'Role', 'Expires on']) await expect(issue.getByLabel(label)).toBeDisabled();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(issue.getByRole('status')).toBeFocused();
    loseResponse();

    const refresh = page.getByRole('button', { name: 'Retry API key refresh' });
    await expect(refresh).toBeFocused();
    await expect(issue).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(newKey).toBeDisabled();
    await expect(page.getByLabel('API key secret')).toHaveValue('');
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(refresh).toBeVisible();
    await refresh.press('Enter');
    const recovery = page.getByRole('status').filter({ hasText: 'Issuance could not be confirmed' });
    await expect(recovery).toBeFocused();
    const rows = page.getByRole('list', { name: 'API keys' }).getByRole('listitem').filter({ hasText: name });
    const matches = rows.filter({ hasText: 'Possible match' });
    await expect(matches).toHaveCount(2);
    const existing = rows.filter({ hasNotText: 'Possible match' });
    await expect(existing).toHaveCount(1);
    await expect(matches.first().getByRole('button', { name: 'Revoke ' + name })).toBeEnabled();
    expect(posts).toBe(1);

    await existing.getByRole('button', { name: 'Revoke ' + name }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke ' + name + '?' });
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await expect(revoke.getByRole('status')).toHaveText('Revoking API key…');
    await expect(revoke.getByRole('status')).toBeFocused();
    await expect(revoke.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(revoke.getByRole('status')).toBeFocused();
    expect((await request.delete(revokePath, { headers })).status()).toBe(204);
    expect((await request.post(path, { headers, data: { name: name + ' concurrent', role: 'write' } })).status()).toBe(201);
    const staleRevoke = page.waitForResponse(response => new URL(response.url()).pathname === revokePath);
    finishRevoke();
    expect((await staleRevoke).status()).toBe(404);
    await expect(revoke).toBeHidden();
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: name + ' concurrent' })).toBeVisible();
    await expect(newKey).toBeFocused();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Installation secret').fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(rows).toHaveCount(3);
    await expect(matches).toHaveCount(0);
  } finally {
    loseResponse();
    finishRevoke();
    const { keys } = await (await request.get(path, { headers })).json() as { keys: { id: string; name: string }[] };
    for (const key of keys.filter(key => key.name.startsWith(name))) await request.delete(path + '/' + key.id, { headers });
  }
});
