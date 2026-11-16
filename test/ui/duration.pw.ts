// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { monitorAction } from './actions';

const headers = { Authorization: 'Bearer ui-test-secret' };

test('duration units save whole seconds and preserve repeating fractions on unit changes', async ({ page, request }) => {
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
  await page.getByLabel('Monitor name', { exact: true }).fill('Duration HTTP');
  await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid');
  await page.getByLabel('Interval unit', { exact: true }).selectOption('minutes');
  await page.getByLabel('Interval', { exact: true }).fill('1.1');
  await page.getByLabel('Timeout', { exact: true }).fill('1');
  for (const unit of ['minutes', 'hours', 'days', 'seconds']) {
    await page.getByLabel('Timeout unit', { exact: true }).selectOption(unit);
  }
  await expect(page.getByLabel('Timeout', { exact: true })).toHaveValue('1');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/operator/monitors'));
  await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const monitor = (await response.json()).monitors.at(-1);
  try {
    expect(monitor).toMatchObject({ kind: 'http', intervalSeconds: 66, timeoutSeconds: 1, failureThreshold: 2, recoveryThreshold: 2 });
    await page.reload();
    await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await monitorAction(page, 'Edit Duration HTTP');
    await expect(page.getByLabel('Interval', { exact: true })).toHaveValue('66');
    await page.getByLabel('Interval unit', { exact: true }).selectOption('days');
    await page.getByLabel('Timeout unit', { exact: true }).selectOption('days');
    const edited = page.waitForResponse(response => response.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    const current = (await (await edited).json()).monitors.find((item: { id: string }) => item.id === monitor.id);
    expect(current).toEqual(monitor);
  } finally {
    await request.delete('/api/operator/monitors/' + monitor.id, { headers });
  }
});

for (const kind of ['http', 'tcp', 'heartbeat']) {
  test(`${kind} duration controls retain bounds, counts and identity through edit and cancel`, async ({ page, request }) => {
    const name = 'Duration ' + kind;
    const target = kind === 'http' ? { url: 'https://example.invalid' } : kind === 'tcp' ? { hostname: 'example.invalid', port: 443 } : {};
    const response = await request.post('/api/operator/monitors', { headers, data: { name, kind, ...target, published: false } });
    expect(response.status()).toBe(201);
    const original = (await response.json()).monitors.at(-1);
    try {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto('/operator');
      await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await monitorAction(page, 'Edit ' + name);
      await expect(page.getByLabel('Check type', { exact: true })).toBeDisabled();
      const interval = kind === 'heartbeat' ? 'Expectation' : 'Interval';
      await page.getByLabel(interval + ' unit', { exact: true }).selectOption('hours');
      await page.getByLabel(interval, { exact: true }).fill('0.025'); // 90 seconds
      if (kind === 'heartbeat') {
        await expect(page.getByLabel('Timeout unit', { exact: true })).toBeHidden();
        await expect(page.getByLabel('Consecutive failures', { exact: true })).toBeHidden();
        await page.getByLabel('Silence unit', { exact: true }).selectOption('days');
        await page.getByLabel('Silence', { exact: true }).fill('1');
        await page.getByLabel('Recovery spacing unit', { exact: true }).selectOption('minutes');
        await page.getByLabel('Recovery spacing', { exact: true }).fill('1.5');
        await page.getByLabel('Recovery receipts', { exact: true }).fill('3');
      } else {
        await expect(page.getByLabel('Silence unit', { exact: true })).toBeHidden();
        await expect(page.getByLabel('Recovery spacing unit', { exact: true })).toBeHidden();
        await page.getByLabel('Timeout unit', { exact: true }).selectOption('minutes');
        await page.getByLabel('Timeout', { exact: true }).fill('0.5');
        await page.getByLabel('Consecutive successes', { exact: true }).fill('3');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const saved = page.waitForResponse(response => response.request().method() === 'PATCH');
      await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
      const edited = (await (await saved).json()).monitors.find((item: { id: string }) => item.id === original.id);
      expect(edited).toMatchObject({ ...original, intervalSeconds: 90, recoveryThreshold: 3, ...(kind === 'heartbeat' ? { silenceSeconds: 86400, recoverySpacingSeconds: 90 } : { timeoutSeconds: 30 }) });
      await monitorAction(page, 'Edit ' + name);
      await expect(page.getByLabel(interval, { exact: true })).toHaveValue('90');
      await page.getByLabel(interval + ' unit', { exact: true }).selectOption('days');
      await page.getByLabel(interval, { exact: true }).fill('0.5');
      await page.locator('#cancel-edit').click();
      await monitorAction(page, 'Edit ' + name);
      await expect(page.getByLabel(interval, { exact: true })).toHaveValue('90');
      await expect(page.getByLabel(interval + ' unit', { exact: true })).toHaveValue('seconds');
      const current = (await (await request.get('/api/operator', { headers })).json()).monitors.find((item: { id: string }) => item.id === original.id);
      expect(current).toEqual(edited);
      const publicStatus = await (await request.get('/api/status')).json();
      expect(publicStatus.monitors.some((item: { id: string }) => item.id === original.id)).toBe(false);
    } finally {
      await request.delete('/api/operator/monitors/' + original.id, { headers });
    }
  });
}

test('duration validation rejects subsecond and out-of-range values without saving or rounding', async ({ page, request }) => {
  await page.goto('/operator');
  await page.getByLabel('Installation secret', { exact: true }).fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'New Monitor', exact: true }).click();
  await page.getByLabel('Monitor name', { exact: true }).fill('Invalid duration');
  await page.getByLabel('HTTP(S) target', { exact: true }).fill('https://example.invalid');
  let saves = 0;
  page.on('request', request => { if (request.method() === 'POST') saves++; });
  const input = page.getByLabel('Interval', { exact: true });
  await page.getByLabel('Interval unit', { exact: true }).selectOption('minutes');
  for (const invalid of ['', '0', '-1', '0.5', '1440.01', '1.01', '1.00000000000000000001']) {
    await input.fill(invalid);
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    expect(await input.evaluate((node: HTMLInputElement) => node.checkValidity()), invalid).toBe(false);
    expect(saves).toBe(0);
  }
  await input.fill('1.01');
  await page.getByLabel('Interval unit', { exact: true }).selectOption('hours');
  await expect(page.getByLabel('Interval unit', { exact: true })).toHaveValue('minutes');
  await expect(input).toHaveValue('1.01');
  // Whole seconds and decimal exponents must not inherit binary floating point errors.
  for (const valid of ['1', '1.1', '1.15', '1.25', '1.44e3']) {
    await input.fill(valid);
    expect(await input.evaluate((node: HTMLInputElement) => node.checkValidity()), valid).toBe(true);
  }
  await page.getByLabel('Interval unit', { exact: true }).selectOption('days');
  await expect(input).toHaveValue('1');
  await input.fill('1.00001');
  expect(await input.evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(false);
  await input.fill('1');
  await page.getByLabel('Timeout unit', { exact: true }).selectOption('minutes');
  const timeout = page.getByLabel('Timeout', { exact: true });
  for (const invalid of ['0', '1.01', '0.01']) {
    await timeout.fill(invalid);
    await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
    expect(await timeout.evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(false);
    expect(saves).toBe(0);
  }
  await timeout.fill('1');
  const saved = page.waitForResponse(response => response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Monitor', exact: true }).click();
  const monitor = (await (await saved).json()).monitors.at(-1);
  try {
    expect(monitor).toMatchObject({ intervalSeconds: 86400, timeoutSeconds: 60 });
    const rejected = await request.patch('/api/operator/monitors/' + monitor.id, {
      headers, data: { name: 'Should not save', intervalSeconds: 60.5 },
    });
    expect(rejected.status()).toBe(400);
    const current = (await (await request.get('/api/operator', { headers })).json()).monitors.find((item: { id: string }) => item.id === monitor.id);
    expect(current).toEqual(monitor);
  } finally {
    await request.delete('/api/operator/monitors/' + monitor.id, { headers });
  }
});
