// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('API key Settings prototype lists, issues, copies and revokes across layouts', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/operator?variant=inline');
  await page.getByLabel('Installation secret').fill('ui-test-secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const keys = page.getByRole('list', { name: 'API keys' });
  const oldKey = keys.getByRole('listitem').filter({ hasText: 'Status dashboard' });
  const secret = page.getByRole('textbox', { name: 'API key secret' });
  const switcher = page.getByRole('navigation', { name: 'Prototype variants' });

  for (const variant of ['inline', 'dialog', 'dedicated']) {
    await expect(page).toHaveURL(new RegExp('variant=' + variant + '$'));
    if (variant === 'dedicated') {
      await page.getByRole('button', { name: 'Manage API keys' }).click();
      await expect(page.getByRole('heading', { name: 'Status page' })).toBeHidden();
    }
    const replacement = keys.getByRole('listitem').filter({ hasText: 'Replacement ' + variant });
    await expect(oldKey).toContainText('Read');
    await expect(secret).toHaveCount(0);
    await page.getByRole('button', { name: 'New API key' }).click();
    const name = page.getByRole('textbox', { name: 'Key name' });
    await expect(name).toBeFocused();
    if (variant === 'dialog') {
      await expect(page.getByRole('dialog', { name: 'New API key' })).toBeVisible();
    }
    await name.fill('Replacement ' + variant);
    await page.getByLabel('Role', { exact: true }).selectOption('write');
    await page.getByLabel('Expires on (optional)', { exact: true }).fill('2099-03-01');
    await page.getByRole('button', { name: 'Issue API key' }).click();
    await expect(secret).toHaveValue(/^demo_/);
    const visibleSecret = await secret.inputValue();
    await page.getByRole('button', { name: 'Copy key' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(visibleSecret);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(secret).toHaveCount(0);
    await expect(replacement).toContainText('Write');
    await expect(replacement).toContainText('Mar 1, 2099');
    await expect(keys).not.toContainText(visibleSecret);
    await expect(oldKey).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await replacement.getByRole('button', { name: 'Revoke Replacement ' + variant }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke Replacement ' + variant + '?' });
    await revoke.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(replacement).toBeVisible();
    await replacement.getByRole('button', { name: 'Revoke Replacement ' + variant }).click();
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await expect(replacement).toHaveCount(0);
    if (variant !== 'dedicated') await switcher.getByRole('button', { name: 'Next variant' }).click();
  }
  await oldKey.getByRole('button', { name: 'Revoke Status dashboard' }).click();
  await page.getByRole('dialog', { name: 'Revoke Status dashboard?' }).getByRole('button', { name: 'Revoke key' }).click();
  await expect(oldKey).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Status page' })).toBeVisible();
  await switcher.getByRole('button', { name: 'Next variant' }).click();
  await expect(oldKey).toHaveCount(0);
});
