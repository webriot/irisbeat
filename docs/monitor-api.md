# Monitor collection integration

Implements [#4](https://github.com/webriot/irisbeat/issues/4) under [spec #1](https://github.com/webriot/irisbeat/issues/1). The selected Status ledger layout is recorded on [#2](https://github.com/webriot/irisbeat/issues/2#issuecomment-6865093219). These are application interfaces, not versioned hosted contracts.

## Requests and responses

All `/api/operator` routes require the installation Bearer secret. JSON mutations retain the 4 KiB limit and credential-free HTTP(S) URL validation. IDs are opaque and newly created IDs are never reused. Missing/deleted IDs return 404; unsupported methods return 405 with `Allow`.

- `GET /api/operator` and `GET /api/operator/monitors`: full operator status.
- `PUT /api/operator` with `{ pageName }`: context-level settings only.
- `POST /api/operator/monitors` with `{ name, url, published? }`: create; defaults to published; 201 and full operator status.
- `PATCH /api/operator/monitors/:id` with one or more of `{ name, url, published }`: edit; 200 and full operator status. Publication is a boolean; unsupported fields/kinds are rejected.
- `DELETE /api/operator/monitors/:id`: remove configuration; 200 and full operator status. No Incident is closed or deleted by this action. A result returning after deletion is discarded.

`GET /api/status` and anonymous HTML include currently published Monitors and their Incidents only. Public Monitors expose `{ id, name, state, lastResult }`. The operator receives `{ id, name, state, lastResult, url, published }`, including private Monitors. Both responses are:

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

For compatibility, the foundation `PUT /api/operator` body `{ pageName, name, url }` still edits the first active Monitor (or creates one when empty). New clients should use the ID-specific routes; the operator UI does. The `monitor` alias is likewise retained for existing clients. New clients must use `monitors[]`.

The Monitor array contains active configuration only. Deleted Monitor names remain on Incidents; the operator UI marks Incidents whose Monitor is absent as deleted. The public banner uses only visible Monitors: an unavailable Monitor takes precedence, all up is operational, otherwise awaiting check; an empty collection says no Monitors published. Maintenance/pause precedence belongs to their later tickets. History bars and later Monitor kinds are absent.

## Persistence and siblings

`src/index.ts` retains one `MonitoringContext` per personal installation. The `context` KV value changes from `{ monitor }` to `{ pageName, monitors }`; the array is the persisted creation order. Each Monitor owns `id`, `name`, `url`, `published`, `state`, `lastResult`, `failures`, `successes`, and `nextDue`. Context page settings are independent of Monitor configuration. `incidents` adds nullable `monitorName`; old rows are backfilled from the legacy Monitor. No existing Incident IDs, timestamps, counters or due times change on migration, and the legacy Monitor becomes published. The constructor applies the additive SQL change; `read()` converts the legacy context on first access, including scheduled access.

This persisted collection format requires a forward application update. Rolling back to the foundation single-Monitor bundle cannot read the collection; restore a pre-upgrade storage backup if a downgrade is necessary. Do not overwrite collection data with a legacy `{ monitor }` write.

For #3 timing: carry timing fields on **each** Monitor, initialize defaults in `newMonitor` and legacy conversion, validate them in create/edit, and carry the attempt's settings through `checkMonitor(id, at)`. Edits preserve runtime state and affect later attempts. Do not attach page settings to Monitors or restore the single-Monitor `configure` overwrite.

For #7 webhooks: keep destination settings at context level, independent of page/Monitor forms. `check(at)` fans out to `checkMonitor(id, at)` with per-ID checking guards. Incident lookup is scoped by `monitorId`; the transition transaction rereads current configuration after external I/O and discards a deleted Monitor's late result. Attach transition delivery to this per-Monitor path and retain private-Monitor delivery. Publication must never gate checks or alerts. Neither sibling was in the integration tip when this implementation began; preserve any sibling fields and delivery when merging.

`test/monitoring.test.ts` retains the foundation's 12 cases and adds collection behavior through Worker requests/scheduled invocations. `test/upgrade.cjs` switches actual Worker bundles over persisted local workerd state without reading storage or private methods. No live deployment or browser automation was performed.
