// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

test('Settings saves independently and preserves Monitor and Settings drafts across navigation and refresh', async ({ page }) => {
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const create = page.getByRole('button', { name: 'New Monitor', exact: true });
  await create.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await create.click();
  await page.getByLabel('Monitor name', { exact: true }).fill('Draft Monitor');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Monitors', exact: true })).toBeHidden();
  await page.getByLabel('Page name', { exact: true }).fill('Saved page');
  await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('https://hooks.example/unsaved');
  await page.getByRole('button', { name: 'Save page', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('Saved');
  await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('https://hooks.example/unsaved');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('https://hooks.example/unsaved');
  await page.getByLabel('Page name', { exact: true }).fill('Unsaved page draft');
  await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('http://hooks.example/rejected');
  await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
  await expect(page.locator('#message')).not.toHaveText('Saved');
  await expect(page.locator('#message')).not.toBeEmpty();
  await expect(page.getByLabel('HTTPS webhook URL', { exact: true })).toHaveValue('http://hooks.example/rejected');
  await page.getByLabel('HTTPS webhook URL', { exact: true }).fill('https://hooks.example/saved');
  await page.getByRole('button', { name: 'Save webhook', exact: true }).click();
  await expect(page.locator('#message')).toHaveText('Saved');
  await expect(page.getByLabel('Page name', { exact: true })).toHaveValue('Unsaved page draft');
  await page.getByRole('button', { name: 'Monitors', exact: true }).click();
  await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('Draft Monitor');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(create).toBeFocused();
});

for (const mobile of [false, true]) {
  test(`Monitor actions support ${mobile ? 'touch' : 'keyboard'}, inline edits and truthful deletion`, async ({ page, request }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const headers = { Authorization: 'Bearer ui-test-secret' };
    const response = await request.post('/api/operator/monitors', { headers, data: { name: 'Action Monitor', kind: 'heartbeat' } });
    const monitor = (await response.json()).monitors.at(-1);
    const path = '/api/operator/monitors/' + monitor.id;
    try {
      await page.goto('/operator');
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const actions = page.getByLabel('Actions for Action Monitor', { exact: true });
      if (mobile) await actions.tap();
      else { await actions.focus(); await actions.press('ArrowDown'); }
      const menu = page.locator('details').filter({ has: actions });
      await expect(menu.locator('button').first()).toHaveText('Edit');
      const bounds = await menu.locator('.menu-items').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
      await menu.getByRole('button', { name: 'Edit Action Monitor', exact: true }).click();
      await expect(menu).not.toHaveAttribute('open', '');
      await expect(page.getByLabel('Monitor name', { exact: true })).toBeFocused();
      await expect(page.getByLabel('Check type', { exact: true })).toBeDisabled();
      const editorPosition = await page.locator('#inline-panels').evaluate(node => ({
        previous: (node.previousElementSibling?.lastElementChild as HTMLElement)?.dataset.monitorId,
        radius: getComputedStyle(document.getElementById('configuration')!).borderRadius,
      }));
      expect(editorPosition).toEqual({ previous: monitor.id, radius: '12px' });
      await page.getByLabel('Monitor name', { exact: true }).fill('Changed draft');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByLabel('Monitor name', { exact: true })).toHaveValue('Changed draft');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(actions).toBeFocused();
      await actions.click();
      await actions.press('Escape');
      await expect(menu).not.toHaveAttribute('open', '');
      await expect(actions).toBeFocused();
      await actions.press('ArrowUp');
      await expect(menu.getByRole('button', { name: 'Delete Action Monitor', exact: true })).toBeFocused();
      await actions.press('Escape');
      await actions.click();
      await page.getByRole('heading', { name: 'Monitors', exact: true }).click();
      await expect(menu).not.toHaveAttribute('open', '');
      const snapshot = async () => (await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === monitor.id);
      const before = await snapshot();
      page.once('dialog', async dialog => {
        expect(dialog.message()).toContain('Action Monitor');
        expect(dialog.message()).toContain(monitor.id);
        expect(dialog.message()).toContain('Checks and publication will stop. Incident history will be retained.');
        await dialog.dismiss();
      });
      await actions.click();
      await page.getByRole('button', { name: 'Delete Action Monitor', exact: true }).click();
      expect(await snapshot()).toEqual(before);
      await expect(actions).toBeFocused();
      page.once('dialog', dialog => dialog.accept());
      await actions.click();
      await page.getByRole('button', { name: 'Delete Action Monitor', exact: true }).click();
      await expect(page.locator('#message')).toHaveText('Deleted');
      await expect(actions).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New Monitor', exact: true })).toBeFocused();
    } finally { await request.delete(path, { headers }); }
  });
}

for (const kind of ['http', 'tcp', 'heartbeat']) {
  test(`${kind} complete form creates, validates, edits and cancels without losing kind-specific settings`, async ({ page, request }) => {
    const headers = { Authorization: 'Bearer ui-test-secret' };
    let id = '';
    const name = 'Form ' + kind + ' ' + crypto.randomUUID();
    try {
      await page.goto('/operator');
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
      await page.getByLabel('Monitor name', { exact: true }).fill(name);
      await page.getByLabel('Check type', { exact: true }).selectOption(kind);
      if (kind === 'http') await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid/health');
      if (kind === 'tcp') {
        await page.getByLabel('Hostname', { exact: true }).fill('db.example.invalid');
        await page.getByLabel('Port', { exact: true }).fill('5432');
      }
      await page.locator('#intervalSeconds').fill('120');
      await page.locator('#recoveryThreshold').fill('4');
      if (kind === 'heartbeat') {
        await page.getByLabel('Silence (seconds)', { exact: true }).fill('360');
        await page.getByLabel('Recovery spacing (seconds)', { exact: true }).fill('180');
      } else {
        await page.getByLabel('Timeout (seconds)', { exact: true }).fill('15');
        await page.getByLabel('Consecutive failures', { exact: true }).fill('3');
      }
      await page.getByLabel('Published', { exact: true }).uncheck();
      // Valid HTML URL, rejected by the Worker: keep the entire draft on failure.
      if (kind === 'http') {
        await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://user:password@example.invalid');
        await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
        await expect(page.locator('#message')).not.toBeEmpty();
        await expect(page.locator('#configuration')).toBeVisible();
        await expect(page.locator('#intervalSeconds')).toHaveValue('120');
        await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid/health');
      }
      await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
      await expect(page.locator('#message')).toHaveText('Saved');
      const saved = (await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { name: string }) => m.name === name);
      id = saved.id;
      expect(saved).toMatchObject({ kind, intervalSeconds: 120, recoveryThreshold: 4, published: false });
      if (kind === 'heartbeat') expect(saved).toMatchObject({ silenceSeconds: 360, recoverySpacingSeconds: 180 });
      else expect(saved).toMatchObject({ timeoutSeconds: 15, failureThreshold: 3 });
      if (kind === 'tcp') expect(saved).toMatchObject({ hostname: 'db.example.invalid', port: 5432 });
      if (kind === 'http') expect(saved.url).toBe('https://example.invalid/health');
      const actions = page.getByLabel('Actions for ' + name, { exact: true });
      await actions.click();
      await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
      await expect(page.getByLabel('Check type', { exact: true })).toBeDisabled();
      await expect(page.locator('#intervalSeconds')).toHaveValue('120');
      if (kind === 'heartbeat') await expect(page.locator('#heartbeat-path')).toHaveText('POST /heartbeat/' + id);
      await page.locator('#recoveryThreshold').fill('101');
      await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
      await expect(page.locator('#configuration')).toBeVisible();
      expect(await page.locator('#recoveryThreshold').evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(true);
      expect((await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === id)).toEqual(saved);
      await page.locator('#recoveryThreshold').fill('4');
      await page.getByLabel('Monitor name', { exact: true }).fill('Edited ' + name);
      await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
      await expect(page.locator('#message')).toHaveText('Saved');
      await expect(page.locator('#configuration')).toBeHidden();
      const edited = (await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === id);
      expect(edited).toEqual({ ...saved, name: 'Edited ' + name });
      await page.getByLabel('Actions for Edited ' + name, { exact: true }).click();
      await page.getByRole('button', { name: 'Edit Edited ' + name, exact: true }).click();
      await page.getByLabel('Monitor name', { exact: true }).fill('Cancelled');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect((await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === id)).toEqual(edited);
    } finally { if (id) await request.delete('/api/operator/monitors/' + id, { headers }); }
  });
}

test('Maintenance and publication actions keep their existing semantics', async ({ page, request }) => {
  const headers = { Authorization: 'Bearer ui-test-secret' };
  const response = await request.post('/api/operator/monitors', { headers, data: { name: 'Maintenance Monitor', kind: 'heartbeat' } });
  const monitor = (await response.json()).monitors.at(-1);
  const path = '/api/operator/monitors/' + monitor.id;
  const snapshot = async () => (await (await request.get('/api/operator', { headers })).json()).monitors.find((m: { id: string }) => m.id === monitor.id);
  try {
    await page.goto('/operator');
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const action = async (name: string) => {
      await page.getByLabel('Actions for Maintenance Monitor', { exact: true }).click();
      await page.getByRole('button', { name: name + ' Maintenance Monitor', exact: true }).click();
    };
    await action('Declare Maintenance');
    await expect(page.getByLabel(/^End time \(/)).toBeFocused();
    await page.locator('#cancel-maintenance').click();
    expect((await snapshot()).maintenance).toBeNull();
    await action('Declare Maintenance');
    await page.getByRole('button', { name: 'Declare Maintenance', exact: true }).click();
    await expect(page.locator('#message')).toHaveText('Saved');
    const initial = (await snapshot()).maintenance;
    expect(initial.endsAt).toBeGreaterThan(Date.now());
    await action('Replace Maintenance');
    const end = new Date(Date.now() + 7200000);
    const local = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await page.getByLabel(/^End time \(/).fill(local);
    await page.getByRole('button', { name: 'Replace Maintenance', exact: true }).click();
    await expect(page.locator('#maintenance')).toBeHidden();
    expect((await snapshot()).maintenance.endsAt).toBeGreaterThan(initial.endsAt);
    await action('End Maintenance');
    await expect(page.locator('#message')).toHaveText('Maintenance ended');
    expect((await snapshot()).maintenance).toBeNull();
    await action('Unpublish');
    await expect(page.locator('#message')).toHaveText('Saved');
    expect((await snapshot()).published).toBe(false);
    await action('Publish');
    await expect(page.locator('#message')).toHaveText('Saved');
    expect((await snapshot()).published).toBe(true);
  } finally { await request.delete(path, { headers }); }
});

test('hosted readers have no mutations; editor heartbeat credentials stay in memory and clear on sign-out', async ({ page, request }) => {
  const origin = new URL(String(test.info().project.use.baseURL));
  origin.hostname = 'localhost';
  const hostedOrigin = origin.origin;
  const headers = { Authorization: 'Bearer ui-editor' };
  const created = await request.post(hostedOrigin + '/api/operator/monitors', { headers, data: { name: 'Hosted producer', kind: 'heartbeat' } });
  const monitor = (await created.json()).monitors.at(-1);
  try {
    await page.goto(hostedOrigin + '/operator');
    await page.getByLabel('Access token', { exact: true }).fill('ui-reader');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Monitor', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeHidden();
    await expect(page.locator('summary')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Access token', { exact: true }).fill('ui-editor');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Actions for Hosted producer', { exact: true }).click();
    await page.getByRole('button', { name: 'Edit Hosted producer', exact: true }).click();
    await expect(page.locator('#heartbeat-path')).toHaveText('POST /heartbeat');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Rotate heartbeat secret', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toContainText('Bearer ');
    const credential = (await page.locator('#heartbeat-credential').textContent())!.slice(7);
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).toEqual({ local: {}, session: {} });
    expect((await request.post(hostedOrigin + '/heartbeat', { headers: { Authorization: 'Bearer ' + credential } })).status()).toBe(204);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#heartbeat-credential')).toBeEmpty();
    await expect(page.getByLabel('Access token', { exact: true })).toHaveValue('');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { await request.delete(hostedOrigin + '/api/operator/monitors/' + monitor.id, { headers }); }
});
