// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

for (const kind of ['http', 'tcp', 'heartbeat']) {
  test(`operator configures, publishes, maintains and deletes a ${kind} Monitor`, async ({ page }) => {
    const name = 'Workflow ' + kind;
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Unauthorized');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
    await page.getByLabel('Monitor name', { exact: true }).fill(name);
    await page.getByLabel('Check type', { exact: true }).selectOption(kind);
    if (kind === 'http') await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid/private-target');
    if (kind === 'tcp') {
      await page.getByLabel('Hostname', { exact: true }).fill('tcp.example.invalid');
      await page.getByLabel('Port', { exact: true }).fill('5432');
    }
    await page.getByLabel('Published', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish ' + name, exact: true })).toBeVisible();
    const historyDay = page.getByRole('cell', { name: name + ' availability', exact: true }).getByRole('listitem').first();
    await historyDay.focus();
    await expect(historyDay).toBeFocused();
    await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
    await expect(page.getByLabel('Check type', { exact: true })).toBeDisabled();
    if (kind === 'heartbeat') await expect(page.locator('#heartbeat-path')).toContainText('POST /heartbeat/');
    await page.getByLabel('Monitor name', { exact: true }).fill(name + ' edited');
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    const edited = name + ' edited';
    await page.getByRole('button', { name: 'Publish ' + edited, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unpublish ' + edited, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Declare Maintenance ' + edited, exact: true }).click();
    await page.getByRole('button', { name: 'Declare Maintenance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'End Maintenance ' + edited, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'End Maintenance ' + edited, exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Maintenance ended');
    await page.getByLabel('Page name', { exact: true }).fill('Workflow status');
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');
    await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('https://alerts.example.invalid/private-token');
    await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#editor')).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('ui-test-secret');
    await page.reload();
    await expect(page.getByLabel('Installation secret', { exact: true })).toHaveValue('');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: edited, exact: true })).toBeVisible();
    const source = await page.content();
    for (const privateValue of ['private-target', 'tcp.example.invalid', 'private-token', 'ui-test-secret']) expect(source).not.toContain(privateValue);
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete ' + edited, exact: true }).click();
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
    await page.getByRole('button', { name: 'Edit Hosted producer', exact: true }).click();
    await expect(page.locator('#heartbeat-path')).toHaveText('POST /heartbeat');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Rotate heartbeat secret', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toContainText('Bearer ');
    const authorization = await page.locator('#heartbeat-credential').textContent();
    expect((await request.post(origin + '/heartbeat', { headers: { Authorization: authorization! } })).status()).toBe(204);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toHaveText('');
    await page.getByLabel('Access token', { exact: true }).fill('ui-reader');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Hosted producer', exact: true })).toBeVisible();
    for (const label of ['New Monitor', 'Save page', 'Save webhook', 'Edit Hosted producer', 'Delete Hosted producer']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeHidden();
    }
    await expect(page.locator('#heartbeat-credential')).toHaveText('');
    expect((await request.patch(origin + '/api/operator/monitors/' + id, {
      headers: { Authorization: 'Bearer ui-reader' }, data: { published: true },
    })).status()).toBe(403);
    await page.reload();
    await expect(page.getByLabel('Access token', { exact: true })).toHaveValue('');
  } finally {
    await request.delete(origin + '/api/operator/monitors/' + id, { headers });
  }
});
