// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/ui',
  testMatch: '**/*.pw.ts',
  use: { baseURL: 'http://127.0.0.1:8787' },
  webServer: {
    command: 'npx wrangler dev test/ui/worker.ts --port 8787 --persist-to .tmp/ui-state --var INSTALLATION_SECRET:ui-test-secret --var STATUS_RENDER_INTERVAL_SECONDS:0',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: false,
  },
});
