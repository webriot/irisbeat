# Irisbeat

Irisbeat is an open source (AGPL-3.0-only), self-hostable Cloudflare monitoring application with HTTP, TCP and Heartbeat checks, Incidents, Maintenance, availability history, webhook alerts and an operator UI.

The application supports multiple personal HTTP(S), TCP and Heartbeat Monitors, authenticated operator configuration, publication controls, and an anonymous Status page with automatic Incidents. Release acceptance is tracked in [spec #1](https://github.com/Webriot/irisbeat/issues/1).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/webriot/irisbeat)

See [installation, operation and release acceptance](docs/install.md). The button uses main. Use the exact-source CLI path to install a specific release.

## Local development

Requires Node.js 22.12 or later and npm. No Cloudflare account or credentials are needed for tests or the dry-run build.

```sh
npm ci
npm run types
npm test
npm run check
npx playwright install chromium
npm run test:ui
npm run build
npm run build:delivery
npm run test:delivery
npm run test:delivery:upgrade
npm run test:status:publication
```

For interactive local use, create an ignored `.dev.vars` file containing `INSTALLATION_SECRET="<your local secret>"`, then run `npm run dev`. Open `/operator` and sign in with that secret. Save a page name and create Monitors with a name and kind. HTTP(S) requires a URL; TCP requires hostname and port; Heartbeat shows its authenticated POST endpoint when edited. Use each ledger row’s Edit, Publish/Unpublish, Maintenance and Delete actions. Edit opens inline; Maintenance opens a dialog for starting, updating the end date or ending early. Open Settings to save the page name or add, replace, and remove HTTPS webhooks in Notification destinations. In Monitors, choose Edit to select any number of destinations and save the Monitor. New Monitors and migrated webhooks start unselected. Replacing an address clears its existing selections. Private Monitors keep checking. Delete removes a Monitor from checking and public visibility while retaining its Incidents for the operator. The secret stays in browser memory until sign-out or reload; it is never stored in browser storage or returned by the API. Use a dedicated secret and HTTPS outside local development.

Both views offer System, Light, and Dark themes. System follows browser preference changes; explicit choices are saved locally when browser storage is available. Theme selection never stores operator credentials. `npm run test:ui` checks rendered themes, keyboard access, mobile layouts, and editor draft preservation against the local Worker.

Local cron dispatch can be triggered at `/__scheduled?cron=*+*+*+*+*`. Deployed cron runs every minute; missed dispatches are not replayed. New Monitors remain “Awaiting check” until observed. HTTP GET accepts every 2xx response and follows redirects; network errors, the configured deadline (ten seconds by default), and non-2xx responses are failures. TCP checks establish a plain connection using native Cloudflare sockets, succeeding when the connection opens; refusal, network errors and the configured deadline are failures. Each socket requests closure without delaying observations or later dispatch. TCP checks do not verify TLS or application protocols. By default, two consecutive failures open an Incident and two consecutive successes close it. The public view subscribes to scoped WebSocket notifications, reads a fresh snapshot on connection, and fetches server-rendered partials for changes. While disconnected it shows Polling, reconnects with backoff and fetches every minute while visible. The operator view uses authenticated WebSocket notifications with single-use HTTP tickets and five-minute authorization leases, renewing in place; it uses the same visible polling fallback. Both resynchronize when returning to the tab. Updates preserve operator drafts and selected history days; failed reads retain the last snapshot with Updates unavailable and a Retry control. Retry fetches without reloading; a successful automatic read or Retry clears the failure. Authorization loss clears the operator session. The public page displays Incident timestamps in the browser locale and timezone, retaining exact UTC instants in machine-readable timestamps.

## Application interfaces

| Boundary | Behavior |
| --- | --- |
| `GET /` | Anonymous Status page; target addresses and credentials omitted |
| `GET /operator` | Accessible operator sign-in and configuration forms |
| `GET /api/status/events/v2` | Same-origin public WebSocket invalidations owned by the context’s hibernating Durable Object; see [subscription contract](docs/hosted-contract.md#public-subscriptions) |
| `POST /api/operator/events/ticket` | Authenticated 30-second single-use operator subscription ticket; readers and editors allowed |
| `GET /api/operator/events/v2` | Same-origin operator WebSocket; first-message ticket authentication and five-minute renewable authorization; see [operator subscriptions](docs/hosted-contract.md#operator-subscriptions) |
| `GET /api/status/partials/<scope>` | Anonymous server-rendered row or section, with a committed revision |
| `GET /api/operator/partials/<scope>` | Authorized server-rendered row or section plus Operator metadata |
| `GET /api/status` | Anonymous page name, published `monitors[]`, last Check results and published-Monitor Incidents |
| `GET /api/operator` or `GET /api/operator/monitors` | All active Monitors with kind, target and publication, editor-only destinations and Monitor selections, plus all retained Incidents; installation Bearer secret required |
| `PUT /api/operator` | Save JSON `{ pageName }` independently; same authorization required |
| `POST /api/operator/monitors` | Create `{ name, kind?, url?, hostname?, port?, published? }` (published by default); returns full operator status with HTTP 201 |
| `PATCH /api/operator/monitors/:id` | Edit name, kind-specific target, publication, timing, `destinationIds` or `destinationChanges`; returns full operator status |
| `DELETE /api/operator/monitors/:id` | Remove configuration; return full operator status with retained Incidents |
| `GET /api/operator/destinations` | Operator snapshot with saved destinations for editors |
| `POST /api/operator/destinations` | Create a webhook with `{ url }` or, when email is configured, an inbox with `{ channel: "email", address }` |
| `PUT /api/operator/destinations/:id` or `DELETE /api/operator/destinations/:id` | Replace or remove a destination and clear prior selections |
| `POST /api/operator/destinations/:id/confirmation` | Request a new confirmation for a pending inbox, subject to a five-minute cooldown |
| `GET /notifications/confirm` and `POST /notifications/confirm` | Display the recipient consent form and explicitly accept a single-use confirmation |
| `GET /notifications/unsubscribe` and `POST /notifications/unsubscribe` | Display the withdrawal form and remove the inbox and its selections from that context with an explicit recipient POST |
| `PUT /api/operator/webhook` | Manage the compatibility destination with `{ url }`; empty string removes it |
| `POST /heartbeat/:id` | Refresh an active Heartbeat with the installation Bearer secret; ignore the body; 204 on success, 404 for unknown/deleted/wrong-kind IDs |
| Worker `scheduled` | Dispatch due HTTP/TCP attempts and evaluate Heartbeat silence independently, including private Monitors |

`src/index.ts` owns Hono HTTP routes and middleware, the Worker scheduled handler, validation, detection and `MonitoringContext` Durable Object. The `MONITORING` binding routes to `getByName('personal')`. SQLite-backed storage persists context-level page settings, creation-ordered Monitors, per-Monitor consecutive counts, due times, last results and Incidents. `src/ui.tsx` renders the document and operator forms with Hono JSX and coordinates browser controls. `src/status-ledger.ts` owns shared initial/live public ledger and operator availability markup. `src/monitor-editor.ts` owns the Monitor configuration editor, including drafts, supported fields, exact duration conversion, Calendar preview presentation and save construction; `src/operator-session.ts` owns authenticated request and preview coordination. The owner-selected A — Status ledger places the public status banner before creation-ordered Monitor rows and Incidents, and inline Monitor configuration within the operator ledger with a separate Settings view. The public banner reports no published Monitors, any unavailable service, all services operational, or awaiting checks; unknown Monitors never imply full health. The responsive layout stacks on smaller screens. Each ledger row includes 90 UTC calendar-day availability bars and its counted-result percentage (or No observations), followed by Incidents. Arrow keys and touch inspect bucket dates and their local-time intervals; no prototype code is integrated. `Status` and `Incident` are exported TypeScript types; [hosted contract 1](docs/hosted-contract.md) provides the versioned consumable engine boundary.

Configuration and publication changes preserve Incident history, current availability and consecutive counts. Deleting during a check discards its late result without fabricating recovery; subsequent checks stop. Incident names are retained for the operator after deletion. New Monitors use unique IDs; the existing single-Monitor state migrates lazily without losing its original ID or detector progress. A check already running uses its starting target, timeout and thresholds and records its result without overwriting newer settings. Timing edits alone never open or close an Incident. Subsequent attempts use the latest configuration. Operator JSON bodies are limited to 4 KiB; heartbeat ingress never reads bodies. TCP targets accept DNS names, IPv4 addresses or IPv6 literals and integer ports 1–65,535. Target URLs may use HTTP or HTTPS but cannot embed username/password credentials. Anonymous responses omit target URLs, TCP hostnames and ports, and the installation secret. The Worker caches static assets, the generic Operator shell, and anonymous Status resources by context. HTTP responses use `Cache-Control: no-store`, and authorized Operator data bypasses the shared cache. [Monitor API and sibling integration notes](docs/monitor-api.md) describe the collection shape, compatibility endpoints and persistence change.

Monitor kind is fixed after creation, as [confirmed by the owner](https://github.com/webriot/irisbeat/issues/5#issuecomment-6866440406). API edits reject type changes, and the operator form locks the type while editing. Create a new Monitor to use another type. Wrong-kind target and timing fields return 400 atomically. Operator responses and controls expose only the selected kind’s target and supported timing fields. Target and timing edits retain the existing identity and history; an active attempt uses its starting target and timing.

Operator duration controls accept seconds, minutes, hours, or days, including fractions that represent whole seconds. Unit changes preserve the exact duration; APIs still use integer seconds. A day means 86,400 elapsed seconds, independently of timezone-aware Calendar Schedules. Count controls remain counts.

HTTP and TCP Monitors also support Calendar Schedules. Choose Interval or Calendar in the operator editor. Calendar uses numeric five-field cron (`minute hour day-of-month month day-of-week`) with wildcards, lists, inclusive ranges and steps, plus a named timezone (UTC by default). Sunday is 0 or 7. When neither day field contains `*`, either matching day qualifies (OR). Wildcards, including wildcard steps, use AND matching between the day fields; step values still apply. Aliases, seconds fields, names, extended operators, impossible dates and invalid timezones are rejected atomically. The editor shows an authoritative live explanation and the next three occurrences in the selected timezone. Nonexistent spring-forward wall times are skipped; repeated wall times run only at their first occurrence.

Calendar creation and schedule edits start at the next future occurrence. Delayed minute dispatch collapses overdue occurrences into one current Check, then returns to the calendar, without replayed observations. Schedule changes reset consecutive detection/recovery progress while retaining identity, results and Incidents; ordinary target/threshold edits and omitted fields retain their existing semantics. Active Checks use their starting target, timeout and thresholds, retain their result, and cannot replace newer settings or seed a changed schedule's progress. Maintenance still records excluded observations and retains open Incidents. Hosted pause records no observations and resume starts at the next future occurrence. Calendar Heartbeat behavior is described below.

HTTP/TCP Monitor timing controls use owner-confirmed integer JSON numbers: `intervalSeconds` 60–86,400 (default 60), `timeoutSeconds` 1–60 (default 10), `failureThreshold` and `recoveryThreshold` 1–100 (default 2 each). The one-minute cron limits dispatch precision; intervals need not be multiples of 60. Timeout is at most the minimum interval to avoid routinely overlapping checks. These are application bounds, not Cloudflare platform limits. Omitted timing fields preserve the existing Monitor's values; new and pre-existing untuned Monitors use the defaults. Null, strings, fractions and out-of-range values return 400 without saving any configuration. Interval edits recalculate the next due time from the most recent attempt's start, including an active attempt; saving never dispatches a check or replays missed attempts. Threshold edits retain consecutive counts and take effect when a later attempt is observed. See [timing ticket #3](https://github.com/Webriot/irisbeat/issues/3) and its [parent specification](https://github.com/Webriot/irisbeat/issues/1).

Heartbeat Monitors use the Watchdog defaults: 60-second expectation, 180-second silence, two recovery receipts at least 60 seconds apart. Creation anchors initial silence; authorized receipts refresh last-seen. Scheduled evaluation opens an Incident only when silence is observed. Duplicate or closely spaced receipts refresh freshness without advancing recovery or moving its spacing anchor. Evaluated silence resets recovery progress. Edits preserve freshness, counts and history and take effect on later receipts/evaluations. Heartbeat seconds bounds are 60–86,400 and recovery count 1–100; these limits and immutable Monitor kind are [owner-confirmed](https://github.com/webriot/irisbeat/issues/6#issuecomment-6866440729). [Heartbeat handoff](docs/heartbeat-api.md) describes the collection and upgrade contract.

Calendar Heartbeats use the same Calendar mode, cron grammar, timezone preview and DST policy. Configure `graceSeconds` (integer 1–86,400, default 30) strictly below every scheduled occurrence gap, including DST-shortened gaps. The editor uses the existing duration units and counts consecutive successful occurrences for recovery. Interval expectation, silence and receipt spacing remain independent and unchanged.

Each Calendar occurrence owns one authenticated receipt window from its scheduled time through its inclusive deadline. Receipts immediately refresh last-seen; early, late and duplicate receipts cannot satisfy another occurrence or advance recovery. Availability and detection finalize only after the window closes, at its deadline. One missed occurrence opens an Incident; recovery needs the configured consecutive successful occurrences (default two). Delayed dispatch evaluates persisted evidence chronologically, at most 128 occurrences per Monitor per invocation, resuming from its durable cursor on later dispatches and after restart. Old missed deadlines still affect detection and original Incident timestamps, but observations are inserted only within the 90 UTC-day retention range. No history before Calendar enablement is invented.

Any actual Maintenance overlap with a receipt window excludes its whole occurrence. Durable overlap evidence survives replacement, early end, expiry and receipts arriving before declaration; Maintenance between windows resets recovery at its chronological boundary. Creation, Calendar schedule or grace changes, and hosted resume begin at the next future occurrence, clear pending evidence and detector progress, and preserve identity, results and Incidents. Resume retains unexpired Maintenance. Authentication, credential rotation and publication keep their existing contracts. Incident notifications use the same Queue path as other Monitor kinds. See [Calendar Heartbeat integration](docs/heartbeat-api.md#calendar-heartbeats).

Saved webhooks and confirmed inboxes become available for Monitor selection.
In Settings, **Add email** appears when the installation has configured the
[optional email bindings](docs/install.md#optional-email-confirmation). The recipient
must explicitly confirm before selection. Confirmation links expire after 24 hours.
Resend replaces the previous link and has a five-minute cooldown per inbox.
A paused context suppresses confirmation sends, including queued confirmations
from before pause. An editor can explicitly resend after resume. New Monitors and upgraded
legacy webhooks start without subscriptions. Editors choose zero or more
destinations through `destinationIds`. Replacing a webhook address clears its old
selections. The editor snapshot includes saved addresses and selections. Public
and hosted-reader snapshots omit both.

HTTP, TCP and Heartbeat enqueue Incident openings and recoveries and Maintenance
starts, end-time changes and endings for destinations selected when the event
commits, including for private Monitors.
A separate delivery Worker rechecks eligibility before sending a bounded,
Slack-compatible webhook POST or submitting HTML and plain-text email through
Cloudflare Email Sending. Both include the original event time. Discord webhook
paths normalize to `/slack`. Each alert email links to an account-free withdrawal
form. Withdrawal removes the inbox and its Monitor selections in that context
and cancels queued alerts that have yet to be submitted. Queue handoff errors
record `notification_enqueue_failed` and preserve the committed change.
The delivery Worker retries temporary submission failures and sends exhausted
jobs to a dead-letter Queue. Settings shows each destination's latest submission
result. See [installation](docs/install.md) and [hosted integration](docs/hosted-contract.md#incident-notifications).

## Runtime verification

`test/operator-notifications.test.ts`, `test/notifications.test.ts`, `test/monitoring.test.ts`, `test/timing.test.ts`, `test/tcp.test.ts`, `test/heartbeat.test.ts`, `test/calendar-heartbeat.test.ts`, `test/calendar-notifications.test.ts`, `test/maintenance.test.ts`, `test/history.test.ts` and `test/pause.test.ts` exercise real Worker requests and scheduled handlers with a real SQLite-backed Durable Object in local `workerd`. The harness controls cron timestamps, substitutes outbound HTTP targets and native socket connections, evicts the object to verify persistence, and asserts only HTTP responses and target behavior. The timeout case substitutes outbound fetch and advances the configured deadline immediately using a narrow runtime timer substitution; broad Vitest fake timers with pending RPC requests crash the current local runtime. `npm run test:delivery` exercises the actual Queue consumer and the trusted service binding in separate local Workers with substituted webhook transport. No test accesses storage tables or private methods. `npm run test:delivery:upgrade` uses the confirmation-only revision from Git history and swaps both Workers over the same SQLite state to verify the first queued alert and account-free withdrawal. `node test/upgrade.cjs` also bundles the actual foundation Worker at `6fb95cc` from local Git history, creates an outage through requests/scheduled invocations, replaces the Worker bundle, and verifies migrated identity, settings, due time, Incident and recovery progress. Pass a commit SHA to also verify upgrades from timing/webhook-enabled single-Monitor bundles; saved webhooks are verified as unselected destinations when supported by that bundle. Pass `8186447fe340a86feefc9d15e1fed670864e9588 tcp` to verify the earlier TCP single-Monitor bundle with a substituted socket target. Pass `106fbc4b57f2174ab55f40c157fe094af910297b --heartbeat` to verify the earlier single-Heartbeat bundle, including creation anchor, freshness, recovery count/spacing and webhook preservation. Collection bundle `1e73abc32bd6e927ee7f3b052faa7a761a466673` is also covered. Pass `82f0180407383ff6f18c915f809058190be8df9c --history` to verify retained #8 observations without reconstructing earlier history. This optional upgrade regression requires that foundation commit locally (fetch repository history if using a shallow clone); it uses the runtime and bundler already supplied by the Cloudflare test plugin.

The harness follows Cloudflare's [Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [request mocking](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). `npm run check` regenerates binding/runtime types from `wrangler.jsonc` and checks TypeScript; generated declarations are ignored. `npm run build` bundles locally with `wrangler deploy --dry-run` and does not deploy.

The configuration declares a monitoring Worker with a one-minute cron, a SQLite Durable Object migration and the required `INSTALLATION_SECRET` name. A separate configuration declares the Queue consumer and Recovery migration. Actual deployments, secret values and account infrastructure belong outside this repository. The Deploy to Cloudflare flow declares its installation-secret prompt and deployment command. Versioned source and engine artifacts with integrity/exact revision metadata are prepared by `npm run release:prepare`; `npm run release:verify` assembles all local acceptance checks. See [publication and deployment checks](docs/install.md).

## Repository boundary

The public application owns the monitoring engine and hosted extension interfaces. Private hosted consumers integrate versioned public releases rather than duplicate the engine. [Hosted contract 1](docs/hosted-contract.md) documents trusted context/permission/allowance resolution, tenant Heartbeat issuance and rotation, and Queue-based Incident and Maintenance notifications. `npm run test:consumer` prepares a reproducible local `irisbeat@0.3.0` tarball and verifies a separately installed, integrity-pinned consumer in workerd. Context pause/resume is included, with durable trusted policy revisions.

Hosted consumers own account integration, organization roles, entitlements, subscription provisioning, monitor allowances, sender and domain provisioning, custom hostnames and hosted deployment. The public application remains independently self-hostable. Infrastructure and secrets belong outside this repository.

## Engineering workflow

Track work in [GitHub Issues](https://github.com/Webriot/irisbeat/issues). Agent conventions are in [AGENTS.md](https://github.com/Webriot/irisbeat/blob/main/AGENTS.md).

## License

Copyright 2026 Webriot.

This project's own code is licensed under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`).

Third-party components retain their own licenses.
