# Irisbeat

Irisbeat is being built as a complete, self-hostable Cloudflare monitoring application. Its planned scope includes HTTP, TCP and heartbeat checks, incidents, maintenance, status pages, webhook alerts and an operator UI.

The first application slice supports one personal HTTP(S) Monitor, authenticated operator configuration, and an anonymous Status page with automatic Incidents. The remaining planned features are tracked in [spec #1](https://github.com/Webriot/irisbeat/issues/1).

## Local development

Requires Node.js 22.12 or later and npm. No Cloudflare account or credentials are needed for tests or the dry-run build.

```sh
npm ci
npm run types
npm test
npm run check
npm run build
```

For interactive local use, create an ignored `.dev.vars` file containing `INSTALLATION_SECRET="<your local secret>"`, then run `npm run dev`. Open `/operator` and sign in with that secret. Configure a page name, Monitor name and HTTP(S) target. The secret stays in browser memory until sign-out or reload; it is never stored in browser storage or returned by the API. Use a dedicated secret and HTTPS outside local development.

Local cron dispatch can be triggered at `/__scheduled?cron=*+*+*+*+*`. Deployed cron runs every minute; missed dispatches are not replayed. New Monitors remain “Awaiting check” until observed. GET accepts every 2xx response and follows redirects; network errors, a ten-second deadline, and non-2xx responses are failures. Two consecutive failures open an Incident, and two consecutive successes close it. The public page refreshes every minute and displays Incident timestamps in UTC.

## Application interfaces

| Boundary | Behavior |
| --- | --- |
| `GET /` | Anonymous Status page; target URLs and credentials omitted |
| `GET /operator` | Accessible operator sign-in and configuration forms |
| `GET /api/status` | Anonymous page name, current Monitor, last Check result and Incidents |
| `GET /api/operator` | Same status plus target URL and context-level `webhookUrl` (or null); installation Bearer secret required |
| `PUT /api/operator` | Save JSON `{ pageName, name, url }`; same authorization required |
| `PUT /api/operator/webhook` | Save JSON `{ url }` independently of Monitor configuration; HTTPS only, empty string removes; same authorization required |
| Worker `scheduled` | Dispatch one due attempt to the personal monitoring context |

`src/index.ts` owns the Worker handlers, validation, detection and `MonitoringContext` Durable Object. The `MONITORING` binding routes to `getByName('personal')`. SQLite-backed storage persists configuration, consecutive counts, due time, last result and Incidents. `src/ui.ts` owns the functional HTML and browser controls; the owner-selected A — Status ledger places the public status banner before the Monitor row and Incidents, and the operator ledger above Monitor configuration with page settings beside it. The responsive layout stacks on smaller screens. History bars and controls from later tickets are intentionally absent; no prototype code is integrated. Webhook controls sit below configuration and save independently. `Status` and `Incident` are exported TypeScript types for subsequent application work, not yet versioned hosted contracts.

Configuration changes preserve Incident history, current availability and consecutive counts. A check already running records its result without overwriting newer settings; subsequent attempts use the updated target. Request bodies are limited to 4 KiB. Target URLs may use HTTP or HTTPS but cannot embed username/password credentials. No target URL or installation secret is included in anonymous responses; all responses disable caching.

Webhook destinations become active when saved; saving does not send a test message or replay an existing Incident. One context-level destination receives JSON `{ "text": "Website: Incident opened" }` and `{ "text": "Website: Incident recovered" }` on actual transitions. Monitor-name whitespace is collapsed so the text stays on one line. Slack URLs remain as entered; Discord and legacy discordapp webhook paths (including canary/ptb and versioned API paths) gain exactly one `/slack` suffix while retaining query parameters. URLs must use HTTPS, omit username/password and fragments, and fit within 2048 characters. The destination is returned only to authenticated operators, never embedded in public HTML, scripts or status JSON.

Delivery is a single POST after detection commits, with a ten-second deadline and no redirects or retries. Transport errors and non-2xx responses log only `webhook_delivery_failed`; upstream bodies, URLs and exceptions are omitted. A failed delivery does not revert an Incident or generate a duplicate opening on later failures. This best-effort path has no durable outbox: a crash between commit and delivery can lose an alert. Maintenance, pause and hosted email delivery remain later work.

For sibling integration: `StoredContext.webhookUrl` and `configureWebhook()` belong to the monitoring context, outside Monitor configuration. Preserve that field when introducing Monitor collections. The `check()` transaction marks `opened` only after inserting an Incident, and `recovered` only when closing it; its single post-transaction `deliverWebhook()` call is the transition emission point. Preserve those conditions per Monitor when adding publication/deletion or timing controls. Webhook saves use `/api/operator/webhook`, not `/api/operator`, and never call `configure()` or alter detection counts or due times. See [ticket #7](https://github.com/Webriot/irisbeat/issues/7) and [parent spec #1](https://github.com/Webriot/irisbeat/issues/1) for the acceptance criteria and later transition policies.

## Runtime verification

`test/monitoring.test.ts` exercises real Worker requests and scheduled handlers with a real SQLite-backed Durable Object in local `workerd`. It controls cron timestamps, substitutes external targets with MSW, evicts the object to verify persistence, and asserts only HTTP responses and target behavior. Substituted webhook endpoints verify activation, editing, single-line named opening/recovery payloads, secrecy, Discord normalization, failed delivery and redirect suppression; a bounded timer substitution covers webhook timeout without external messages. The timeout case substitutes outbound fetch and advances the configured deadline immediately using a narrow runtime timer substitution; broad Vitest fake timers with pending RPC requests crash the current local runtime. No test accesses storage tables or private methods.

The harness follows Cloudflare's [Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [request mocking](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). `npm run check` regenerates binding/runtime types from `wrangler.jsonc` and checks TypeScript; generated declarations are ignored. `npm run build` bundles locally with `wrangler deploy --dry-run` and does not deploy.

The configuration declares the public application runtime only: one Worker, a one-minute cron, a SQLite Durable Object migration and the required `INSTALLATION_SECRET` name. Actual deployments, secret values and account infrastructure belong outside this repository. TCP, Heartbeat, timing controls, Maintenance, pause, publication controls, availability bars, hosted adapters and a Deploy to Cloudflare flow remain later tickets. No real deployment or browser interaction automation has been performed.

## Repository boundary

The public application owns the monitoring engine and hosted extension interfaces. Private hosted consumers integrate versioned public releases rather than duplicate the engine.

Hosted consumers own account integration, organization roles, entitlements, subscription provisioning, monitor allowances, email delivery, custom hostnames and hosted deployment. The public application remains independently self-hostable. Infrastructure and secrets belong outside this repository.

## Engineering workflow

Track work in [GitHub Issues](https://github.com/Webriot/irisbeat/issues). Agent conventions are in [AGENTS.md](AGENTS.md).

## License

Copyright 2026 Webriot.

This project's own code is licensed under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).

Third-party components retain their own licenses.
