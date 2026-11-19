// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { withDelivery } from '../notification-delivery.cjs';
import { monitorAction } from './actions';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('Recipients confirm and withdraw a selected inbox from captured mail', async ({ page, browser }) => {
  await withDelivery(async (dispatch, confirmationLinkFor, unsubscribeLinkFor) => {
    const origin = 'https://personal.example';
    async function connect(tab: typeof page) {
      await tab.addInitScript(() => {
        Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('offline'); } } });
      });
      await tab.route(origin + '/**', async route => {
        const request = route.request();
        const response = await dispatch(request.url(), {
          method: request.method(), headers: await request.allHeaders(), body: request.postData(),
        });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      });
    }

    await connect(page);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(origin + '/operator');
    await page.getByLabel('Installation secret').fill('test-installation-secret');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'New Monitor' }).click();
    await page.getByLabel('Monitor name', { exact: true }).fill('Email Monitor');
    await page.getByLabel('Check type').selectOption('heartbeat');
    await page.getByRole('button', { name: 'Save Monitor' }).click();
    await monitorAction(page, 'Edit Email Monitor');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add email' });
    await add.focus();
    await page.keyboard.press('Enter');
    const address = 'ui+confirm@example.net';
    const editor = page.getByRole('form', { name: 'Add email', exact: true });
    await expect(editor.getByLabel('Email address')).toBeFocused();
    await expect(editor.getByRole('heading')).toHaveCount(0);
    await page.getByLabel('Email address').fill(address);
    await page.getByRole('button', { name: 'Save email' }).click();
    await expect(page.getByText('Pending confirmation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resend confirmation ' + address })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const recipient = await browser.newPage();
    try {
      await connect(recipient);
      const link = await confirmationLinkFor(address);
      try {
        await recipient.goto(link);
      } catch {
        throw new Error('Could not open the captured confirmation link');
      }
      await expect(recipient.getByRole('heading', { name: 'Confirm email notifications' })).toBeVisible();
      await expect(page.getByText('Pending confirmation')).toBeVisible();
      await page.getByRole('button', { name: 'Monitors', exact: true }).click();
      const choice = page.getByRole('checkbox', { name: address, exact: true });
      await expect(choice).toHaveCount(0);
      await recipient.getByRole('button', { name: 'Confirm email' }).focus();
      await recipient.keyboard.press('Enter');
      await expect(recipient.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(choice).toBeVisible();
      await expect(choice).not.toBeChecked();
      await choice.focus();
      await page.keyboard.press('Space');
      await expect(choice).toBeChecked();
      await page.getByRole('button', { name: 'Save Monitor' }).click();
      await monitorAction(page, 'Edit Email Monitor');
      await expect(choice).toBeChecked();

      const headers = { Authorization: 'Bearer test-installation-secret', 'Content-Type': 'application/json' };
      const snapshot = await (await dispatch(origin + '/api/operator', { headers })).json();
      const maintenance = await dispatch(origin + '/api/operator/monitors/' + snapshot.monitor.id + '/maintenance', {
        method: 'PUT', headers, body: JSON.stringify({ endsAt: Date.now() + 300_000 }),
      });
      expect(maintenance.status).toBe(200);
      const unsubscribeLink = await unsubscribeLinkFor(address);
      try {
        await recipient.goto(unsubscribeLink);
      } catch {
        throw new Error('Could not open the captured unsubscribe link');
      }
      await expect(recipient.getByRole('heading', { name: 'Unsubscribe from email notifications' })).toBeVisible();
      await expect(choice).toBeChecked();
      await recipient.getByRole('button', { name: 'Unsubscribe', exact: true }).focus();
      await recipient.keyboard.press('Enter');
      await expect(recipient.getByRole('heading', { name: 'Email unsubscribed' })).toBeVisible();
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(choice).toHaveCount(0);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByText(address, { exact: true })).toHaveCount(0);
    } finally {
      await recipient.close();
    }
  });
});
