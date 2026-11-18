# Monitor collection integration

Implements [#4](https://github.com/webriot/irisbeat/issues/4) under [spec #1](https://github.com/webriot/irisbeat/issues/1). The selected Status ledger layout is recorded on [#2](https://github.com/webriot/irisbeat/issues/2#issuecomment-6865093219). These are application interfaces, not versioned hosted contracts.

## Requests and responses

All `/api/operator` routes require the installation Bearer secret. JSON mutations retain the 4 KiB limit and credential-free HTTP(S) URL validation; Heartbeat requires no target. TCP targets accept DNS names, IPv4 or IPv6 literals and integer ports 1–65535. IDs are opaque and newly created IDs are never reused. Missing/deleted IDs return 404; unsupported methods return 405 with `Allow`.

- `GET /api/operator` and `GET /api/operator/monitors`: full operator status.
- `PUT /api/operator/webhook` with `{ url }`: manage the compatibility webhook independently; empty string removes it. Authenticated `GET /api/operator/webhook` also returns full operator status.
- `PUT /api/operator` with `{ pageName }`: context-level settings only.
- `POST /api/operator/monitors` with `{ name, kind?, url?, hostname?, port?, published?, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold?, silenceSeconds?, recoverySpacingSeconds? }`: create; defaults to published; 201 and full operator status.
- `PATCH /api/operator/monitors/:id` with one or more of `{ name, kind, url, hostname, port, published, intervalSeconds, timeoutSeconds, failureThreshold, recoveryThreshold, silenceSeconds, recoverySpacingSeconds }`: edit; 200 and full operator status. Publication is a boolean; unsupported fields/kinds are rejected. Omitted `kind` on creation means HTTP and requires `url`; TCP creation requires `kind: "tcp"`, `hostname` and `port`. PATCH validates against the current ID-specific target, so a port-only or hostname-only edit preserves the other field. Heartbeat creation requires `kind: "heartbeat"` and no target. Kind is fixed after creation; changes and foreign target/timing fields return 400 without saving any fields. ID-specific parsing and mutation stay together inside the DO.
- To opt in to notifications, add HTTPS webhooks in Operator Settings, then edit each Monitor and check the desired destinations. To do the same by API, send `{ destinationIds: [...] }` to `PATCH /api/operator/monitors/:id` for a complete list or `{ destinationChanges: { [id]: true | false } }` for individual changes. See the [hosted contract](hosted-contract.md) for details.
- `POST /heartbeat/:id`: installation Bearer authorization; body ignored; 204 for an active Heartbeat, 404 for unknown/deleted/HTTP/TCP IDs.
- `DELETE /api/operator/monitors/:id`: remove configuration; 200 and full operator status. No Incident is closed or deleted by this action. A result returning after deletion is discarded.

`GET /api/status` and anonymous HTML include currently published Monitors and their Incidents only. Public Monitors expose `{ id, name, kind, state, lastResult }`, plus `lastSeen` for Heartbeat. Operators additionally receive publication and supported kind-specific fields: HTTP `url`, TCP `hostname`/`port`, and outbound `intervalSeconds`, `timeoutSeconds`, `failureThreshold`, `recoveryThreshold`; Heartbeat `intervalSeconds`, `silenceSeconds`, `recoveryThreshold`, `recoverySpacingSeconds`, with no target. Private Monitors are included only for operators. Editors receive `destinations`, Monitor `destinationIds` and the compatibility `webhookUrl`. Both responses otherwise are:

```ts
{
  pageName: string;
  monitors: MonitorView[]; // creation order; edits and publication never reorder
  monitor: MonitorView | null; // compatibility alias: first visible Monitor
  incidents: {
    id: string;
    monitorId: string;
    monitorName: string | null; // name captured on opening (backfilled on upgrade)
    openedAt: number;
    closedAt: number | null;
  }[]; // newest first; operators retain private/deleted Monitor history
}
```

For compatibility, the foundation `PUT /api/operator` body `{ pageName, name, url, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold? }` still edits the first active Monitor (or creates one when empty). A legacy save pins the first Monitor before reading the request body; if that identity changes before mutation, it returns 409 without saving Monitor or page settings. Changed kind returns 400. Neither rejection saves page or Monitor settings. Reload before retrying. New clients should use the ID-specific routes; the operator UI does. The `monitor` alias is likewise retained for existing clients. New clients must use `monitors[]`.

The Monitor array contains active configuration only. Deleted Monitor names remain on Incidents; the operator UI marks Incidents whose Monitor is absent as deleted. The public banner uses only visible Monitors: an unavailable Monitor takes precedence, all up is operational, otherwise awaiting check; an empty collection says no Monitors published. Maintenance/pause precedence belongs to their later tickets. HTTP, TCP and Heartbeat coexist in the same Status ledger; history bars remain later work.

## Persistence and siblings

`src/index.ts` retains one `MonitoringContext` per personal installation. The `context` KV value changes from `{ monitor, webhookUrl? }` to `{ pageName, monitors, webhookUrl? }`; the array is the persisted creation order. Each Monitor owns `id`, `name`, `kind`, its target (`url` or `hostname`/`port`), `published`, `state`, `lastResult`, `failures`, `successes`, `nextDue`, and supported timing fields. Heartbeat additionally persists `createdAt`, `lastSeen` and `recoveryReceiptAt`. Timing defaults are 60-second interval, 10-second timeout and thresholds of 2; validation retains the owner-confirmed #3 bounds documented in README. Context page and webhook settings are independent of Monitor configuration. Legacy conversion preserves all existing context fields outside `monitor`, including a saved webhook destination even when no Monitor was configured. `incidents` adds nullable `monitorName`; old rows are backfilled from the legacy Monitor. No existing Incident IDs, timestamps, counters or due times change on migration, and the legacy Monitor becomes published. The constructor applies the additive SQL change; `read()` converts the legacy context on first access, including scheduled access.

This persisted collection format requires a forward application update. Rolling back to the foundation single-Monitor bundle cannot read the collection; restore a pre-upgrade storage backup if a downgrade is necessary. Do not overwrite collection data with a legacy `{ monitor }` write.

Integration #2/#3/#4/#6/#7 is merged at `3b524d867c6d77625fb00ad0fe02722cb128a49e`, now merged into TCP PR #19. Heartbeat fields, ingress, upgrade tests and confirmed owner choices are documented in [Heartbeat handoff](heartbeat-api.md). The seven timing integration cases and all webhook cases remain through the compatibility contract. Collection tests additionally cover per-Monitor timing create/edit/persistence, validation and concurrent ID-specific edits. The four fields are initialized in `newMonitor` and legacy conversion; omitted fields preserve existing values. `applyEdit` recalculates next due from the last dispatch start, including active attempts. `checkMonitor(id, at)` uses the starting target, timeout and thresholds and rereads current state before recording the result. Page, webhook and publication saves do not change runtime state.

TCP #5 is integrated into collection creation/patching and operator forms. `Target` is the HTTP/TCP/Heartbeat union; kind-less stored HTTP Monitors gain the HTTP default on read, and single-Monitor TCP state migrates with its original target and runtime progress. Each `checkMonitor(id, at)` snapshots its own kind, target and timing, dispatching either HTTP fetch or native `connect().opened`. Per-ID guards, Incident lookup, publication independence and late-deletion discard apply to all three kinds. Heartbeat uses scheduled silence evaluation and authorized inbound receipts instead of outbound attempts. Native socket closure remains attached to the Durable Object lifetime without blocking observation or later dispatch; synchronous/asynchronous cleanup errors are handled. IPv6 is normalized without brackets in configuration and bracketed at the socket boundary. See [TCP handoff](tcp-monitoring.md). Immutable kind is owner-confirmed; create a new Monitor for a different kind.

[Incident notifications](hosted-contract.md#incident-notifications) supersede the
original context-wide webhook behavior. Existing addresses become unselected
destinations. The shared Incident detector commits before direct Queue submission.
Deleting a Monitor discards its late results and cancels unsubmitted work.
Publication does not gate checks or selected notifications.

`test/monitoring.test.ts` retains the foundation's 12 cases and adds collection behavior through Worker requests/scheduled invocations. `test/tcp.test.ts` adds mixed HTTP/TCP creation/order, partial per-ID target/timing edits, publication/privacy, independent failure/recovery and named private alerts, eviction, deletion during a pending socket, active snapshots and immutable-kind validation. `test/timing.test.ts` retains all seven timing cases, including threshold edits and attempt snapshots with emitted alerts. `test/upgrade.cjs` switches actual Worker bundles over persisted local workerd state without reading storage or private methods. Run it against foundation `6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3`, timing `0a9a0e84686e312930f9743a25b9af186de38818` and webhook integration `e0bfa2b6b99300f851282158e3e24126bea8bc57`; webhook-capable bundles save a destination before upgrade and verify that the address is retained without implicit selections. Also run `node test/upgrade.cjs 1e73abc32bd6e927ee7f3b052faa7a761a466673` for kind-less collections and `node test/upgrade.cjs 8186447fe340a86feefc9d15e1fed670864e9588 tcp` for the approved TCP slice; the latter substitutes only the socket target boundary. No live deployment or browser automation was performed.

Combined verification: 67 runtime tests, generated types/TypeScript, dry-run build and script syntax pass. All six actual-bundle upgrade modes pass, including `node test/upgrade.cjs 106fbc4b57f2174ab55f40c157fe094af910297b --heartbeat`. New three-kind tests cover independent detection/alerts, private filtering, heartbeat spacing, page-only saves, deletion history and cross-kind rejection. See TCP/Heartbeat handoffs for review provenance; this combined head awaits fresh independent review. Hosted #10 remains separate: retain the three-kind collection, atomic DO-side patches and ignored-body heartbeat ingress when adding extension interfaces.

## HTTP and TCP Calendar Schedules

HTTP and TCP collection creates/patches accept additive `scheduleMode: "interval" | "calendar"`. Omission preserves the existing mode; older Monitors default to Interval. Calendar requires `cron` and accepts `timezone` (named timezone, default `UTC`). Operator responses include the mode and active Calendar fields; anonymous projections omit them. Interval retains its integer `intervalSeconds`, including when switching back from Calendar. A patch to `scheduleMode: "interval"` removes the Calendar configuration; do not include `cron` or `timezone` in that patch. Calendar Heartbeats use the same schedule fields with receipt windows; see [Heartbeat integration](heartbeat-api.md#calendar-heartbeats).

Calendar accepts numeric five-field cron, wildcards, comma lists, inclusive ranges, and positive steps; single-value steps run from that value through the field maximum. Sunday is 0 or 7. Day fields containing `*` (including wildcard steps such as `*/1` and `*/2`) use AND matching; OR applies only when neither day field contains `*`. Steps still filter their field values: `0 9 */1 * 1` runs Mondays, while `0 9 */2 * 1` runs only Mondays on odd-numbered dates. Invalid grammar, impossible month/date combinations and invalid named timezones return 400 without saving any fields. Spring gaps are skipped and fall folds use only the first wall-time occurrence.

Authenticated editors can `POST /api/operator/schedule-preview` with `{ cron, timezone?, after? }`, where optional `after` is an epoch-millisecond instant (default now). It returns `{ cron, timezone, explanation, occurrences }` with three epoch-millisecond instants strictly after `after`. The endpoint uses the same backend calculation as dispatch and applies existing authorization, reader restrictions, 4 KiB JSON limit and no-store headers. It never changes configuration or dispatches Checks.

Creation, mode/cron/timezone changes, and hosted resume anchor at the next future occurrence. A delayed dispatch executes one current Check and persists the next future occurrence before outbound I/O. Identity, last results, availability and open Incidents survive schedule edits; consecutive progress resets. Active attempts retain starting configuration and do not overwrite newer schedules or seed their consecutive progress. Maintenance observations and pause suppression use the existing detector/history/delivery paths. Interval timing edits keep the established last-dispatch anchor and progress semantics.

HTTP and TCP reuse the Calendar calculation in `src/calendar.ts`, the preview endpoint, and the same schedule controls. TCP occurrences use native plain connections with the configured timeout and existing bounded cleanup. Calendar Heartbeat receipt windows remain separate.
