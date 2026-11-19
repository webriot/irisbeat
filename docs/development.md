# Local development

Start from a checkout of the source repository with Node.js 22.12 or later and npm.

1. Run `npm ci`.
2. Create an ignored `.dev.vars` file in the repository root with `INSTALLATION_SECRET="<your local secret>"`. Use a dedicated local value.
3. Run `npm run dev`, open `/operator` on the URL Wrangler prints, and sign in with that secret. The public status page is at `/`.

To dispatch scheduled checks, open `/cdn-cgi/local/scheduled` on the local Worker.
Wrangler discards local Analytics Engine writes. The tests simulate Analytics
Engine locally. [Cloudflare's local cron guide](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)

## Checks

These checks run locally without a Cloudflare account.

| Command | Coverage |
| --- | --- |
| `npm run check` | Regenerates Wrangler binding and runtime types, then checks TypeScript. |
| `npm test` | Exercises Worker requests and scheduled handlers with SQLite-backed Durable Objects in local workerd. The tests control time and substitute external services. |
| `npx playwright install chromium`, then `npm run test:ui` | Checks rendered workflows, keyboard access, mobile layouts, themes, and draft preservation. |
| `npm run build` and `npm run build:delivery` | Bundles both Workers using Wrangler's dry-run mode. |
| `npm run test:delivery` | Runs the Queue consumer and trusted service binding in separate local Workers. |
| `npm run test:consumer` | Installs a locally packed, integrity-pinned engine and exercises both exports. |
| `npm run test:delivery:upgrade` and `npm run test:status:publication` | Swap predecessor bundles over persisted state to verify notification and public status upgrades. Use a checkout with Git history. |

Run a single suite with `npm test -- test/heartbeat.test.ts` or
`npm run test:ui -- test/ui/operator.pw.ts`. Older bundle tests use committed
fixtures from Git history. Use `node test/calendar-cost.cjs` for a manual
Calendar validation benchmark.

See [release verification](install.md#prepare-and-verify-a-release-no-publication) for the full release check and predecessor commands.

## Source layout

- [`src/worker.ts`](../src/worker.ts) is the entry point Wrangler runs for self-hosted installations.
- [`src/index.ts`](../src/index.ts) defines the Hono routes, scheduled handler, and SQLite-backed `MonitoringContext` Durable Object. A self-hosted Worker uses the `personal` context.
- [`src/ui.tsx`](../src/ui.tsx) renders the pages. [`src/status-ledger.ts`](../src/status-ledger.ts) shares ledger markup between initial renders and live updates. [`src/monitor-editor.ts`](../src/monitor-editor.ts) and [`src/operator-session.ts`](../src/operator-session.ts) handle drafts, configuration, and authenticated browser requests.
- [`src/notification-delivery.ts`](../src/notification-delivery.ts) consumes the notification Queue and delivers eligible alerts.
