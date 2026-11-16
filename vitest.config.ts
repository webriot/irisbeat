// SPDX-License-Identifier: AGPL-3.0-only
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: ["test/ui*.test.ts", "**/node_modules/**"] },
  plugins: [
    cloudflareTest({
      main: "./test/history-worker.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { INSTALLATION_SECRET: "test-installation-secret" },
      },
    }),
  ],
});
