// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { monitorAction } from './actions';

for (const kind of ['http', 'tcp', 'heartbeat']) {
  test(`operator configures, publishes, maintains and deletes a ${kind} Monitor`, async ({ page }) => {
    const name = 'Workflow ' + kind + ' ' + Date.now();
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Unauthorized');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
    await page.getByLabel('Monitor name', { exact: true }).fill(name);
    await page.getByLabel('Check type', { exact: true }).selectOption(kind);
    if (kind === 'http') await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid/private-target');
    if (kind === 'tcp') {
      await page.getByLabel('Hostname', { exact: true }).fill('tcp.example.invalid');
      const port = page.getByLabel('Port', { exact: true });
      await expect(port).toHaveAttribute('min', '1');
      await expect(port).toHaveAttribute('max', '65535');
      await port.fill('5432');
    }
    await page.getByLabel('Published', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish ' + name, exact: true })).toBeVisible();
    const historyDay = page.getByRole('cell', { name: name + ' availability', exact: true }).getByRole('listitem').first();
    await historyDay.focus();
    await expect(historyDay).toBeFocused();
    await monitorAction(page, 'Edit ' + name);
    await expect(page.getByLabel('Check type', { exact: true })).toBeDisabled();
    if (kind === 'heartbeat') await expect(page.locator('#heartbeat-path')).toContainText('POST /heartbeat/');
    await page.getByLabel('Monitor name', { exact: true }).fill(name + ' edited');
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    const edited = name + ' edited';
    await monitorAction(page, 'Publish ' + edited);
    await expect(page.getByRole('button', { name: 'Unpublish ' + edited, exact: true })).toBeVisible();
    await monitorAction(page, 'Maintenance ' + edited);
    await page.getByRole('button', { name: 'Start Maintenance', exact: true }).click();
    await monitorAction(page, 'Maintenance ' + edited);
    await page.getByRole('button', { name: 'End Maintenance', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Maintenance ended');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Page name', { exact: true }).fill('Workflow status');
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#editor')).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('ui-test-secret');
    await page.reload();
    await expect(page.getByLabel('Installation secret', { exact: true })).toHaveValue('');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: edited, exact: true })).toBeVisible();
    const source = await page.content();
    expect(source).not.toContain('ui-test-secret');
    if (kind === 'http') expect(source).not.toContain('private-target');
    if (kind === 'tcp') expect(source).not.toContain('tcp.example.invalid');
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await monitorAction(page, 'Delete ' + edited);
    await expect(page.getByRole('button', { name: 'Edit ' + edited, exact: true })).toHaveCount(0);
  });
}

test('hosted editor rotates Heartbeat credentials and reader sees a read-only ledger', async ({ page, request, baseURL }) => {
  const origin = baseURL!.replace('127.0.0.1', 'localhost');
  const headers = { Authorization: 'Bearer ui-editor' };
  const created = await request.post(origin + '/api/operator/monitors', {
    headers, data: { name: 'Hosted producer', kind: 'heartbeat', published: false },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).monitors.at(-1).id;
  try {
    await page.goto(origin + '/operator');
    await page.getByLabel('Access token', { exact: true }).fill('ui-editor');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await monitorAction(page, 'Edit Hosted producer');
    await expect(page.locator('#heartbeat-path')).toHaveText('POST /heartbeat');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Rotate heartbeat secret', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toContainText('Bearer ');
    const authorization = await page.locator('#heartbeat-credential').textContent();
    expect((await request.post(origin + '/heartbeat', { headers: { Authorization: authorization! } })).status()).toBe(204);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await page.getByLabel('HTTPS webhook URL').fill('https://alerts.example.invalid/hosted-private-token');
    await page.getByRole('button', { name: 'Save webhook' }).click();
    const destination = 'https://alerts.example.invalid/hosted-private-token';
    await expect(page.getByRole('button', { name: 'Replace ' + destination })).toBeVisible();
    await page.getByRole('button', { name: 'Monitors', exact: true }).click();
    const selection = page.getByRole('checkbox', { name: destination, exact: true });
    await selection.check();
    await page.getByRole('button', { name: 'Save Monitor' }).click();
    await monitorAction(page, 'Edit Hosted producer');
    await expect(selection).toBeChecked();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toHaveText('');
    await expect(page.locator('#destination-rows')).toBeEmpty();
    await expect(page.locator('#destination-choices')).toBeEmpty();
    await expect(page.locator('#destination-address')).toHaveValue('');

    await page.getByLabel('Access token', { exact: true }).fill('ui-reader');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Hosted producer', exact: true })).toBeVisible();
    for (const label of ['New Monitor', 'Save page', 'Add webhook', 'Edit Hosted producer', 'Publish Hosted producer', 'Maintenance Hosted producer', 'Delete Hosted producer']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeHidden();
    }
    await expect(page.locator('#heartbeat-credential')).toHaveText('');
    expect(await page.content()).not.toContain('hosted-private-token');
    const reader = { Authorization: 'Bearer ui-reader' };
    const snapshot = await (await request.get(origin + '/api/operator', { headers: reader })).json();
    expect(snapshot.destinations).toBeUndefined();
    expect(snapshot.monitors.find((monitor: { id: string }) => monitor.id === id).destinationIds).toBeUndefined();
    expect((await request.post(origin + '/api/operator/destinations', { headers: reader, data: { url: 'https://example.invalid' } })).status()).toBe(403);
    expect((await request.patch(origin + '/api/operator/monitors/' + id, {
      headers: { Authorization: 'Bearer ui-reader' }, data: { published: true },
    })).status()).toBe(403);
    await page.reload();
    await expect(page.getByLabel('Access token', { exact: true })).toHaveValue('');
  } finally {
    await request.delete(origin + '/api/operator/monitors/' + id, { headers });
    const data = await (await request.get(origin + '/api/operator', { headers })).json();
    for (const destination of data.destinations.filter((item: { url: string }) => item.url.endsWith('/hosted-private-token'))) {
      await request.delete(origin + '/api/operator/destinations/' + destination.id, { headers });
    }
  }
});

test('refreshes only the saved section while the Operator connection is offline', async ({ page }) => {
  await page.routeWebSocket('**/api/operator/events/v2', socket => socket.close());
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const requests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith('/api/operator')) requests.push(url.pathname);
  });
  const name = page.getByLabel('Page name');
  await name.fill('  Disconnected save  ');
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(name).toHaveValue('Disconnected save');
  await expect(page.locator('#message')).toHaveText('Saved');
  expect(requests).toEqual(['/api/operator/partials/page']);
});
