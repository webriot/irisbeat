// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';

export async function monitorAction(page: Page, action: string) {
  const name = action.replace(/^(Edit|Publish|Unpublish|Declare Maintenance|Replace Maintenance|End Maintenance|Delete) /, '');
  const trigger = page.getByLabel('Actions ' + name, { exact: true });
  if (await trigger.locator('..').getAttribute('open') === null) await trigger.click();
  await page.getByRole('button', { name: action, exact: true }).click();
}
