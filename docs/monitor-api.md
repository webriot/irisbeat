# Monitor collection integration

Implements [#4](https://github.com/webriot/irisbeat/issues/4) under [spec #1](https://github.com/webriot/irisbeat/issues/1). The selected Status ledger layout is recorded on [#2](https://github.com/webriot/irisbeat/issues/2#issuecomment-6865093219). These are application interfaces, not versioned hosted contracts.

## Requests and responses

All `/api/operator` routes require the installation Bearer secret. JSON mutations retain the 4 KiB limit and credential-free HTTP(S) URL validation. TCP targets accept DNS names, IPv4 or IPv6 literals and integer ports 1–65535. IDs are opaque and newly created IDs are never reused. Missing/deleted IDs return 404; unsupported methods return 405 with `Allow`.

- `GET /api/operator` and `GET /api/operator/monitors`: full operator status.
- `PUT /api/operator/webhook` with `{ url }`: save context destination independently; empty string removes it. Authenticated `GET /api/operator/webhook` also returns full operator status.
- `PUT /api/operator` with `{ pageName }`: context-level settings only.
- `POST /api/operator/monitors` with `{ name, kind?, url?, hostname?, port?, published?, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold? }`: create; defaults to published; 201 and full operator status.
- `PATCH /api/operator/monitors/:id` with one or more of `{ name, kind, url, hostname, port, published, intervalSeconds, timeoutSeconds, failureThreshold, recoveryThreshold }`: edit; 200 and full operator status. Publication is a boolean; unsupported fields/kinds are rejected. Omitted `kind` on creation means HTTP and requires `url`; TCP creation requires `kind: "tcp"`, `hostname` and `port`. PATCH validates against the current ID-specific target, so a port-only or hostname-only edit preserves the other field. Kind changes remain supported pending owner policy; supply a valid target for the new kind. Inactive target fields are cleared on kind changes.
- `DELETE /api/operator/monitors/:id`: remove configuration; 200 and full operator status. No Incident is closed or deleted by this action. A result returning after deletion is discarded.

`GET /api/status` and anonymous HTML include currently published Monitors and their Incidents only. Public Monitors expose `{ id, name, state, lastResult }`. The operator additionally receives `kind`, either `url` or `hostname`/`port`, `published`, `intervalSeconds`, `timeoutSeconds`, `failureThreshold` and `recoveryThreshold`, including private Monitors. Authenticated responses also include context-level `webhookUrl: string | null`; it is absent from public responses. Both responses otherwise are:

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

For compatibility, the foundation `PUT /api/operator` body `{ pageName, name, url, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold? }` still edits the first active Monitor (or creates one when empty). A legacy save pins the first Monitor before reading the request body; if that identity changes before mutation, it returns 409 without saving Monitor or page settings. Reload before retrying. New clients should use the ID-specific routes; the operator UI does. The `monitor` alias is likewise retained for existing clients. New clients must use `monitors[]`.

The Monitor array contains active configuration only. Deleted Monitor names remain on Incidents; the operator UI marks Incidents whose Monitor is absent as deleted. The public banner uses only visible Monitors: an unavailable Monitor takes precedence, all up is operational, otherwise awaiting check; an empty collection says no Monitors published. Maintenance/pause precedence belongs to their later tickets. History bars and later Monitor kinds are absent; HTTP and TCP share the same ledger and detection path.

## Persistence and siblings

`src/index.ts` retains one `MonitoringContext` per personal installation. The `context` KV value changes from `{ monitor, webhookUrl? }` to `{ pageName, monitors, webhookUrl? }`; the array is the persisted creation order. Each Monitor owns `id`, `name`, `kind`, its target (`url` or `hostname`/`port`), `published`, `state`, `lastResult`, `failures`, `successes`, `nextDue`, and the four timing fields. Timing defaults are 60-second interval, 10-second timeout and thresholds of 2; validation retains the owner-confirmed #3 bounds documented in README. Context page and webhook settings are independent of Monitor configuration. Legacy conversion preserves all existing context fields outside `monitor`, including a saved webhook destination even when no Monitor was configured. `incidents` adds nullable `monitorName`; old rows are backfilled from the legacy Monitor. No existing Incident IDs, timestamps, counters or due times change on migration, and the legacy Monitor becomes published. The constructor applies the additive SQL change; `read()` converts the legacy context on first access, including scheduled access.

This persisted collection format requires a forward application update. Rolling back to the foundation single-Monitor bundle cannot read the collection; restore a pre-upgrade storage backup if a downgrade is necessary. Do not overwrite collection data with a legacy `{ monitor }` write.

Integration #2/#3/#7 is merged at `e0bfa2b6b99300f851282158e3e24126bea8bc57`. The seven timing integration cases and all webhook cases remain through the compatibility contract. Collection tests additionally cover per-Monitor timing create/edit/persistence, validation and concurrent ID-specific edits. The four fields are initialized in `newMonitor` and legacy conversion; omitted fields preserve existing values. `applyEdit` recalculates next due from the last dispatch start, including active attempts. `checkMonitor(id, at)` uses the starting target, timeout and thresholds and rereads current state before recording the result. Page, webhook and publication saves do not change runtime state.

TCP #5 is integrated into collection creation/patching and operator forms. `Target` is the HTTP/TCP union; kind-less stored HTTP Monitors gain the HTTP default on read, and single-Monitor TCP state migrates with its original target and runtime progress. Each `checkMonitor(id, at)` snapshots its own kind, target and timing, dispatching either HTTP fetch or native `connect().opened`. Per-ID guards, Incident lookup, publication independence and late-deletion discard apply to both. Native socket closure remains attached to the Durable Object lifetime without blocking observation or later dispatch; synchronous/asynchronous cleanup errors are handled. IPv6 is normalized without brackets in configuration and bracketed at the socket boundary. See [TCP handoff](tcp-monitoring.md). Immutable kind remains an owner question; this integration preserves the TCP slice's kind-change behavior.

Webhook #7 is integrated: `StoredContext.webhookUrl` and `configureWebhook()` belong to the context, outside Monitor/page forms. `check(at)` fans out to `checkMonitor(id, at)` with per-ID checking guards. Incident lookup and transitions are scoped by `monitorId`; the transition transaction rereads current configuration after external I/O and discards a deleted Monitor's late result. A single post-transaction `deliverWebhook()` call emits that Monitor's opening or recovery with its current name and destination. Publication never gates checks or alerts. Failed or timed-out delivery cannot undo detection or cause duplicate transitions; no redirects or retries, ten-second deadline. There is no durable outbox: a crash after commit can lose an alert. Deleting configuration emits no recovery and prevents late results from creating transitions; a delivery already started for a committed transition is not recalled.

`test/monitoring.test.ts` retains the foundation's 12 cases and adds collection behavior through Worker requests/scheduled invocations. `test/tcp.test.ts` adds mixed HTTP/TCP creation/order, partial per-ID target/timing edits, publication/privacy, independent failure/recovery and named private alerts, eviction, deletion during a pending socket, active snapshots and kind-change compatibility. `test/timing.test.ts` retains all seven timing cases, including threshold edits and attempt snapshots with emitted alerts. `test/upgrade.cjs` switches actual Worker bundles over persisted local workerd state without reading storage or private methods. Run it against foundation `6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3`, timing `0a9a0e84686e312930f9743a25b9af186de38818` and webhook integration `e0bfa2b6b99300f851282158e3e24126bea8bc57`; webhook-capable bundles save a destination before upgrade and prove retained delivery after upgrade. Also run `node test/upgrade.cjs 1e73abc32bd6e927ee7f3b052faa7a761a466673` for kind-less collections and `node test/upgrade.cjs 8186447fe340a86feefc9d15e1fed670864e9588 tcp` for the approved TCP slice; the latter substitutes only the socket target boundary. No live deployment or browser automation was performed.
