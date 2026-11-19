// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('Operator renewal preserves the draft and only snapshots for recovery', async ({ page, request, baseURL }) => {
  const origin = baseURL!.replace('127.0.0.1', 'localhost');
  const api = origin + '/api/operator';
  const editor = { Authorization: 'Bearer ui-editor' };
  const created = await request.post(api + '/monitors', {
    headers: editor, data: { name: 'Renewal Monitor', kind: 'heartbeat', published: false },
  });
  expect(created.status()).toBe(201);
  const monitor = (await created.json()).monitors.find((item: { name: string }) => item.name === 'Renewal Monitor');
  const monitorURL = api + '/monitors/' + monitor.id;
  const rename = async (name: string) => {
    expect((await request.patch(monitorURL, { headers: editor, data: { name } })).ok()).toBe(true);
  };
  const nameCell = page.locator(`#monitor-rows [data-key="${monitor.id}"] td`).first();
  const draft = page.getByLabel('HTTPS webhook URL');
  let snapshots = 0;
  let connections = 0;
  let authorizations = 0;
  let permission = 'editor';
  let stale = false;
  await page.route(url => url.href === api || url.href === api + '/events/ticket', route => {
    expect(route.request().headers().authorization).toBe(editor.Authorization);
    if (route.request().method() === 'GET' && route.request().url() === api) snapshots++;
    return route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer ui-' + permission } });
  });
  await page.route(url => url.href.startsWith(api + '/partials'), route =>
    stale ? route.fulfill({ status: 409, body: 'Revision unavailable' }) : route.continue());
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/api/operator/events/v2')) return;
    connections++;
    socket.on('framereceived', frame => {
      if (frame.payload === 'authorized' || frame.payload === 'renewed') authorizations++;
    });
  });

  try {
    await page.clock.install();
    await page.goto(origin + '/operator');
    await page.getByLabel('Access token', { exact: true }).fill('ui-editor');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => snapshots).toBe(2);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add webhook' }).click();
    await draft.fill('https://draft.example/hook');

    await rename('Renewal before');
    await expect(nameCell).toHaveText('Renewal before');
    await page.clock.fastForward(240001);
    await expect.poll(() => authorizations).toBe(2);
    await rename('Renewal after');
    await expect(nameCell).toHaveText('Renewal after');
    expect(connections).toBe(1);
    expect(snapshots).toBe(2);
    await expect(draft).toHaveValue('https://draft.example/hook');
    await expect(draft).toBeFocused();

    stale = true;
    await rename('Renewal gap recovery');
    await expect(nameCell).toHaveText('Renewal gap recovery');
    expect(connections).toBe(2);
    expect(snapshots).toBe(3);
    await expect(draft).toHaveValue('https://draft.example/hook');

    permission = 'reader';
    await page.clock.fastForward(240001);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
    await expect(draft).toHaveValue('');
    await expect(nameCell).toBeVisible();
    expect(connections).toBe(2);
    expect(snapshots).toBe(4);

    permission = 'denied';
    await page.clock.fastForward(240001);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('#monitor-rows')).toBeEmpty();
    expect(snapshots).toBe(4);
  } finally {
    await request.delete(monitorURL, { headers: editor });
  }
});
