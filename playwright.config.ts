// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.IRISBEAT_UI_PORT || 8787);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test',
  testMatch: ['ui/*.pw.ts', 'browser/*.pw.mjs'],
  use: { baseURL },
  webServer: {
    command: `npx wrangler dev test/ui/worker.ts --port ${port} --inspector-port 0 --persist-to .tmp/ui-state-${port} --var INSTALLATION_SECRET:ui-test-secret`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
