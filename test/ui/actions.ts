// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';

export async function monitorAction(page: Page, action: string) {
  await page.getByRole('button', { name: action, exact: true }).click();
}
