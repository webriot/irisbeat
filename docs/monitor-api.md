# Monitor collection integration

Implements [#4](https://github.com/webriot/irisbeat/issues/4) under [spec #1](https://github.com/webriot/irisbeat/issues/1). The selected Status ledger layout is recorded on [#2](https://github.com/webriot/irisbeat/issues/2#issuecomment-6865093219). These are application interfaces, not versioned hosted contracts.

## Requests and responses

All `/api/operator` routes require the installation Bearer secret. JSON mutations retain the 4 KiB limit and credential-free HTTP(S) URL validation for HTTP Monitors; Heartbeat creation requires no URL. IDs are opaque and newly created IDs are never reused. Missing/deleted IDs return 404; unsupported methods return 405 with `Allow`.

- `GET /api/operator` and `GET /api/operator/monitors`: full operator status.
- `PUT /api/operator/webhook` with `{ url }`: save context destination independently; empty string removes it. Authenticated `GET /api/operator/webhook` also returns full operator status.
- `PUT /api/operator` with `{ pageName }`: context-level settings only.
- `POST /api/operator/monitors` with `{ name, kind?, url?, published?, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold?, silenceSeconds?, recoverySpacingSeconds? }`: create; kind defaults to HTTP; defaults to published; 201 and full operator status.
- `PATCH /api/operator/monitors/:id` with one or more of `{ name, kind, url, published, intervalSeconds, timeoutSeconds, failureThreshold, recoveryThreshold, silenceSeconds, recoverySpacingSeconds }`: edit; 200 and full operator status. Publication is a boolean; unsupported fields/kinds and changes to kind are rejected. Immutable kind and heartbeat-specific bounds are owner-confirmed on #6.
- `POST /heartbeat/:id`: installation Bearer authorization, no body parsing; refresh only active Heartbeat IDs, including private ones. Unknown/deleted/wrong-kind returns 404 without freshness change.
- `DELETE /api/operator/monitors/:id`: remove configuration; 200 and full operator status. No Incident is closed or deleted by this action. A result returning after deletion is discarded.

`GET /api/status` and anonymous HTML include currently published Monitors and their Incidents only. Public Monitors expose `{ id, name, kind, state, lastResult }` and `lastSeen` for Heartbeat; only published Monitors appear. The operator additionally receives `url`, `published`, `intervalSeconds`, `timeoutSeconds`, `failureThreshold` and `recoveryThreshold`, plus `silenceSeconds` and `recoverySpacingSeconds`, including private Monitors. Authenticated responses also include context-level `webhookUrl: string | null`; it is absent from public responses. Both responses otherwise are:

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

For compatibility, the foundation `PUT /api/operator` body `{ pageName, name, url, intervalSeconds?, timeoutSeconds?, failureThreshold?, recoveryThreshold? }` still edits the first active Monitor (or creates one when empty). A legacy save pins the Monitor selected during validation; if that identity or kind changes before mutation, it returns 409 without saving Monitor or page settings. Reload before retrying. New clients should use the ID-specific routes; the operator UI does. The `monitor` alias is likewise retained for existing clients. New clients must use `monitors[]`.

The Monitor array contains active configuration only. Deleted Monitor names remain on Incidents; the operator UI marks Incidents whose Monitor is absent as deleted. The public banner uses only visible Monitors: an unavailable Monitor takes precedence, all up is operational, otherwise awaiting check; an empty collection says no Monitors published. Maintenance/pause precedence belongs to their later tickets. Heartbeat is supported alongside HTTP; history bars and TCP remain later work.

## Persistence and siblings

`src/index.ts` retains one `MonitoringContext` per personal installation. The `context` KV value changes from `{ monitor, webhookUrl? }` to `{ pageName, monitors, webhookUrl? }`; the array is the persisted creation order. Each Monitor additionally owns `kind`, `createdAt`, `lastSeen`, `recoveryReceiptAt`, `silenceSeconds` and `recoverySpacingSeconds`. Each Monitor owns `id`, `name`, `url`, `published`, `state`, `lastResult`, `failures`, `successes`, `nextDue`, and the four timing fields. Timing defaults are 60-second interval, 10-second timeout and thresholds of 2; validation retains the owner-confirmed #3 bounds documented in README. Context page and webhook settings are independent of Monitor configuration. Legacy conversion preserves all existing context fields outside `monitor`, including a saved webhook destination even when no Monitor was configured. `incidents` adds nullable `monitorName`; old rows are backfilled from the legacy Monitor. No existing Incident IDs, timestamps, counters or due times change on migration, and the legacy Monitor becomes published. The constructor applies the additive SQL change; `read()` converts the legacy context on first access, including scheduled access.

This persisted collection format requires a forward application update. Rolling back to the foundation single-Monitor bundle cannot read the collection; restore a pre-upgrade storage backup if a downgrade is necessary. Do not overwrite collection data with a legacy `{ monitor }` write.

Integration #2/#3/#4/#7 is merged at `1e73abc32bd6e927ee7f3b052faa7a761a466673`. Heartbeat fields, ingress, upgrade tests and confirmed owner choices are documented in [Heartbeat handoff](heartbeat-api.md). The seven timing integration cases and all webhook cases remain through the compatibility contract. Collection tests additionally cover per-Monitor timing create/edit/persistence, validation and concurrent ID-specific edits. The four fields are initialized in `newMonitor` and legacy conversion; omitted fields preserve existing values. `applyEdit` recalculates next due from the last dispatch start, including active attempts. `checkMonitor(id, at)` uses the starting target, timeout and thresholds and rereads current state before recording the result. Page, webhook and publication saves do not change runtime state.

For TCP #5: extend `MonitorConfiguration`, create/edit validation, `newMonitor`, legacy conversion if needed, and the attempt execution branch in `checkMonitor`; keep IDs opaque and use `monitors[]`. The discriminator is now `"http" | "heartbeat"`; pre-heartbeat HTTP entries default to `http`. TCP PR #19 has not been merged; its eventual union must retain the heartbeat ingress guard and owner-confirmed immutable-kind policy. Return only safe kind-specific fields publicly, keeping targets and credentials in authorized responses. The creation-order array and per-ID Incident lookup/late-deletion guard apply to every kind.

Webhook #7 is integrated: `StoredContext.webhookUrl` and `configureWebhook()` belong to the context, outside Monitor/page forms. `check(at)` fans out to `checkMonitor(id, at)` with per-ID checking guards. Incident lookup and transitions are scoped by `monitorId`; the transition transaction rereads current configuration after external I/O and discards a deleted Monitor's late result. A single post-transaction `deliverWebhook()` call emits that Monitor's opening or recovery with its current name and destination. Publication never gates checks or alerts. Failed or timed-out delivery cannot undo detection or cause duplicate transitions; no redirects or retries, ten-second deadline. There is no durable outbox: a crash after commit can lose an alert. Deleting configuration emits no recovery and prevents late results from creating transitions; a delivery already started for a committed transition is not recalled.

`test/monitoring.test.ts` retains the foundation's 12 cases and adds collection behavior through Worker requests/scheduled invocations. `test/timing.test.ts` retains all seven timing cases, including threshold edits and attempt snapshots with emitted alerts. `test/upgrade.cjs` switches actual Worker bundles over persisted local workerd state without reading storage or private methods. Run it against foundation `6fb95ccec52d9c5c29b82f82c3d77ed3a7e356d3`, timing `0a9a0e84686e312930f9743a25b9af186de38818` and webhook integration `e0bfa2b6b99300f851282158e3e24126bea8bc57`; webhook-capable bundles save a destination before upgrade and prove retained delivery after upgrade. No live deployment or browser automation was performed.
