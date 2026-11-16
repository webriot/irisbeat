// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.pw.mjs',
  use: { browserName: 'chromium', headless: true },
});
