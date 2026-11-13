# Irisbeat

Irisbeat is being built as a complete, self-hostable Cloudflare monitoring application. Its planned scope includes HTTP, TCP and heartbeat checks, incidents, maintenance, status pages, webhook alerts and an operator UI.

The application supports multiple personal HTTP(S) and Heartbeat Monitors, authenticated operator configuration, publication controls, and an anonymous Status page with automatic Incidents. The remaining planned features are tracked in [spec #1](https://github.com/Webriot/irisbeat/issues/1).

## Local development

Requires Node.js 22.12 or later and npm. No Cloudflare account or credentials are needed for tests or the dry-run build.

```sh
npm ci
npm run types
npm test
npm run check
npm run build
```

For interactive local use, create an ignored `.dev.vars` file containing `INSTALLATION_SECRET="<your local secret>"`, then run `npm run dev`. Open `/operator` and sign in with that secret. Save a page name and create Monitors with a name and kind. HTTP(S) Monitors require a target; Heartbeat Monitors show their authenticated POST endpoint when edited. Publish or unpublish each Monitor from its ledger row; private Monitors keep checking. Delete removes a Monitor from checking and public visibility while retaining its Incidents for the operator. The secret stays in browser memory until sign-out or reload; it is never stored in browser storage or returned by the API. Use a dedicated secret and HTTPS outside local development.

Local cron dispatch can be triggered at `/__scheduled?cron=*+*+*+*+*`. Deployed cron runs every minute; missed dispatches are not replayed. New Monitors remain “Awaiting check” until observed. GET accepts every 2xx response and follows redirects; network errors, the configured deadline (ten seconds by default), and non-2xx responses are failures. By default, two consecutive failures open an Incident and two consecutive successes close it. The public page refreshes every minute and displays Incident timestamps in UTC.

## Application interfaces

| Boundary | Behavior |
| --- | --- |
| `GET /` | Anonymous Status page; target URLs and credentials omitted |
| `GET /operator` | Accessible operator sign-in and configuration forms |
| `GET /api/status` | Anonymous page name, published `monitors[]`, last Check results and published-Monitor Incidents |
| `GET /api/operator` or `GET /api/operator/monitors` | All active Monitors with target URL/publication, context-level `webhookUrl` (or null), plus all retained Incidents; installation Bearer secret required |
| `PUT /api/operator` | Save JSON `{ pageName }` independently; same authorization required |
| `POST /api/operator/monitors` | Create `{ name, kind?, url?, published? }` (HTTP by default; Heartbeat needs no URL) (published by default); returns full operator status with HTTP 201 |
| `PATCH /api/operator/monitors/:id` | Edit name, URL, publication or timing fields; returns full operator status |
| `DELETE /api/operator/monitors/:id` | Remove configuration; return full operator status with retained Incidents |
| `PUT /api/operator/webhook` | Save `{ url }` independently of Monitor/page settings; HTTPS only, empty string removes |
| `POST /heartbeat/:id` | Refresh an active Heartbeat with the installation Bearer secret; ignore the body; 204 on success, 404 for unknown/deleted/HTTP IDs |
| Worker `scheduled` | Dispatch due HTTP attempts and evaluate Heartbeat silence independently, including private Monitors |

`src/index.ts` owns the Worker handlers, validation, detection and `MonitoringContext` Durable Object. The `MONITORING` binding routes to `getByName('personal')`. SQLite-backed storage persists context-level page settings, creation-ordered Monitors, per-Monitor consecutive counts, due times, last results and Incidents. `src/ui.ts` owns the functional HTML and browser controls; the owner-selected A — Status ledger places the public status banner before creation-ordered Monitor rows and Incidents, and the operator ledger above Monitor configuration with separate page settings beside it. The public banner reports no published Monitors, any unavailable service, all services operational, or awaiting checks; unknown Monitors never imply full health. The responsive layout stacks on smaller screens. History bars and controls from later tickets are intentionally absent; no prototype code is integrated. `Status` and `Incident` are exported TypeScript types; [hosted contract 1](docs/hosted-contract.md) provides the versioned consumable engine boundary.

Configuration and publication changes preserve Incident history, current availability and consecutive counts. Deleting during a check discards its late result without fabricating recovery; subsequent checks stop. Incident names are retained for the operator after deletion. New Monitors use unique IDs; the existing single-Monitor state migrates lazily without losing its original ID or detector progress. A check already running uses its starting target, timeout and thresholds and records its result without overwriting newer settings. Timing edits alone never open or close an Incident. Subsequent attempts use the latest configuration. Operator JSON request bodies are limited to 4 KiB; heartbeat ingress never reads bodies. Target URLs may use HTTP or HTTPS but cannot embed username/password credentials. No target URL or installation secret is included in anonymous responses; all responses disable caching. [Monitor API and sibling integration notes](docs/monitor-api.md) describe the collection shape, compatibility endpoints and persistence change.

HTTP Monitor timing controls use owner-confirmed integer JSON numbers: `intervalSeconds` 60–86,400 (default 60), `timeoutSeconds` 1–60 (default 10), `failureThreshold` and `recoveryThreshold` 1–100 (default 2 each). The one-minute cron limits dispatch precision; intervals need not be multiples of 60. Timeout is at most the minimum interval to avoid routinely overlapping checks. These are application bounds, not Cloudflare platform limits. Omitted timing fields preserve the existing Monitor's values; new and pre-existing untuned Monitors use the defaults. Null, strings, fractions and out-of-range values return 400 without saving any configuration. Interval edits recalculate the next due time from the most recent attempt's start, including an active attempt; saving never dispatches a check or replays missed attempts. Threshold edits retain consecutive counts and take effect when a later attempt is observed. See [timing ticket #3](https://github.com/Webriot/irisbeat/issues/3) and its [parent specification](https://github.com/Webriot/irisbeat/issues/1).

Heartbeat Monitors use the Watchdog defaults: 60-second expectation, 180-second silence, two recovery receipts at least 60 seconds apart. Creation anchors initial silence; authorized receipts refresh last-seen. Scheduled evaluation opens an Incident only when silence is observed. Duplicate or closely spaced receipts refresh freshness without advancing recovery or moving its spacing anchor. Evaluated silence resets recovery progress. Edits preserve freshness, counts and history and take effect on later receipts/evaluations. Heartbeat seconds bounds are 60–86,400 and recovery count 1–100; these limits and immutable Monitor kind are [owner-confirmed](https://github.com/webriot/irisbeat/issues/6#issuecomment-6866440729). [Heartbeat handoff](docs/heartbeat-api.md) describes the collection and upgrade contract.

Webhook destinations become active when saved; saving does not send a test message or replay an existing Incident. One context-level destination receives JSON `{ "text": "Website: Incident opened" }` and `{ "text": "Website: Incident recovered" }` on actual transitions. Monitor-name whitespace is collapsed so the text stays on one line. Slack URLs remain as entered; Discord and legacy discordapp webhook paths (including canary/ptb and versioned API paths) gain exactly one `/slack` suffix while retaining query parameters. URLs must use HTTPS, omit username/password and fragments, and fit within 2048 characters. The destination is returned only to authenticated operators, never embedded in public HTML, scripts or status JSON.

Delivery is a single POST after detection commits, with a ten-second deadline and no redirects or retries. Transport errors and non-2xx responses log only `webhook_delivery_failed`; upstream bodies, URLs and exceptions are omitted. A failed delivery does not revert an Incident or generate a duplicate opening on later failures. This best-effort path has no durable outbox: a crash between commit and delivery can lose an alert. Maintenance, pause and hosted email delivery remain later work.

The context-level `webhookUrl` survives page/Monitor saves and legacy migration. Each `checkMonitor()` emits only its own committed opening/recovery, including private Monitors. A result returning after deletion is discarded before detection or delivery. Webhook saves never alter detector counts or due times. See [Monitor API handoff](docs/monitor-api.md) for integration details.

## Runtime verification

`test/monitoring.test.ts`, `test/timing.test.ts` and `test/heartbeat.test.ts` exercise real Worker requests and scheduled handlers with a real SQLite-backed Durable Object in local `workerd`. The harness controls cron timestamps, substitutes external targets with MSW, evicts the object to verify persistence, and asserts only HTTP responses and target behavior. The timeout case substitutes outbound fetch and advances the configured deadline immediately using a narrow runtime timer substitution; broad Vitest fake timers with pending RPC requests crash the current local runtime. Substituted webhook endpoints verify single named opening/recovery alerts per Monitor, private alerts, activation, destination retention, secrecy, normalization and failed/bounded delivery. No test accesses storage tables or private methods. `node test/upgrade.cjs` also bundles the actual foundation Worker at `6fb95cc` from local Git history, creates an outage through requests/scheduled invocations, replaces the Worker bundle, and verifies migrated identity, settings, due time, Incident and recovery progress. Pass a commit SHA to also verify upgrades from timing/webhook-enabled single-Monitor bundles; saved webhook destinations and subsequent delivery are verified when supported by that bundle. Use `node test/upgrade.cjs 106fbc4b57f2174ab55f40c157fe094af910297b --heartbeat` to verify single-Heartbeat identity, initial silence, freshness, recovery count/spacing and webhook preservation. The same script accepts the pre-heartbeat collection commit `1e73abc32bd6e927ee7f3b052faa7a761a466673` for HTTP collection upgrades. These tests replace actual Worker bundles over persisted local workerd state and control ingress time through a test-only wrapper. This optional upgrade regression requires that foundation commit locally (fetch repository history if using a shallow clone); it uses the runtime and bundler already supplied by the Cloudflare test plugin.

The harness follows Cloudflare's [Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [request mocking](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). `npm run check` regenerates binding/runtime types from `wrangler.jsonc` and checks TypeScript; generated declarations are ignored. `npm run build` bundles locally with `wrangler deploy --dry-run` and does not deploy.

The configuration declares the public application runtime only: one Worker, a one-minute cron, a SQLite Durable Object migration and the required `INSTALLATION_SECRET` name. Actual deployments, secret values and account infrastructure belong outside this repository. TCP, Maintenance, pause, availability bars and a Deploy to Cloudflare flow remain later tickets. Hosted contract 1 is prepared as a local release candidate; it has not been published or deployed. No real deployment or browser interaction automation has been performed.

## Repository boundary

The public application owns the monitoring engine and hosted extension interfaces. Private hosted consumers integrate versioned public releases rather than duplicate the engine. [Hosted contract 1](docs/hosted-contract.md) documents trusted context/permission/allowance resolution, tenant heartbeat issuance/rotation and post-commit delivery hooks. `npm run test:consumer` prepares a reproducible local `irisbeat@0.1.0` tarball and verifies a separately installed, integrity-pinned consumer in workerd. Final publication belongs to #12; context pause remains #11.

Hosted consumers own account integration, organization roles, entitlements, subscription provisioning, monitor allowances, email delivery, custom hostnames and hosted deployment. The public application remains independently self-hostable. Infrastructure and secrets belong outside this repository.

## Engineering workflow

Track work in [GitHub Issues](https://github.com/Webriot/irisbeat/issues). Agent conventions are in [AGENTS.md](AGENTS.md).

## License

Copyright 2026 Webriot.

This project's own code is licensed under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).

Third-party components retain their own licenses.
