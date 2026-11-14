# Maintenance handoff

Implements [#8](https://github.com/webriot/irisbeat/issues/8) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product policy lives in those
issues; this document describes integration points.

## Controls and status

- `PUT /api/operator/monitors/:id/maintenance` accepts `{ "endsAt": <epoch milliseconds> }`.
  Starts immediately using server time; replaces the one existing window. End time
  must be a safe integer in the future within the JavaScript Date range.
- `DELETE /api/operator/monitors/:id/maintenance` ends early. Repeating it after
  expiry/end is harmless and does not reset subsequent detector progress.
- Both require installation Bearer authorization, use the existing bounded JSON
  reader for PUT, return full operator status, and return 404 for deleted/unknown IDs.
  HTTP, TCP and Heartbeat share these routes. Future scheduling is outside #8.
- Monitor status adds `maintenance: { startedAt, endsAt } | null` and overrides the
  displayed `state` with `maintenance` while effective. The stored detector state
  and Incident identity remain intact. `lastResult.outcome` adds `maintenance`.
  Public status still filters private Monitors and omits targets/destinations.
- The existing ledger exposes declare/replace/end actions. The end input uses the
  operator's local time and sends epoch milliseconds. Public rows show Maintenance;
  open published Incidents take banner precedence, then all-Maintenance, then mixed
  operational/Maintenance, operational, or awaiting checks.

Expiry is lazy at the next request/receipt/evaluation, with the exact end timestamp
excluded from the window. It requires no cron execution or alarm to become visible.
Expiry/early end reset outbound counts and Heartbeat recovery count/spacing without
changing due times, last-seen, last result, availability, or Incidents. No missing
execution becomes a result. Heartbeat receipts during Maintenance refresh last-seen
and record Maintenance, including closely spaced receipts; they never recover an
Incident. Subsequent recovery requires the Monitor's normal post-window rule.

## History #9

The additive SQLite `observations` table retains executed observations from this
revision forward: `id INTEGER PRIMARY KEY`, `monitorId TEXT`, `at INTEGER` (epoch
milliseconds), `outcome TEXT` (`success`, `failure`, `maintenance`). Outbound `at`
retains the existing attempt-start convention. Heartbeat receipts and actual
scheduled silence evaluations use their event timestamp. No row is generated for a
missing/not-due/in-flight-skipped execution or merely entering/ending Maintenance.
Rows survive eviction and Monitor deletion; the last result is also observable in
normal status responses. Maintenance replaces the raw outcome so it cannot enter
the success/failure denominator. There is no public raw-history endpoint.

[History #9](history-api.md) implements aggregation, query/filter contracts, indexes and bounded observation cleanup.
Prior historical observations cannot be reconstructed from the single last result;
this change does not synthesize them. Existing Incident history is unchanged.

## Hosted #10 and pause #11

`maintenance(id, value, end?)` is a synchronous DO operation. The route uses hosted editor authorization and hides reader controls.
Retain adapter context resolution, operator metadata, allowance enforcement and
heartbeat credential rotation. Suppression returns from shared `record` before
Incident mutation or post-commit delivery; both `deliverWebhook` and
`onIncidentTransition` remain downstream of it. Installed-consumer tests cover
both delivery paths for HTTP, TCP and Heartbeat. There are no Maintenance
transition alert events. A webhook submitted before declaration cannot be recalled;
a hosted hook still waiting behind that delivery is suppressed if Maintenance is
active when it would start.

#11 makes pause override Maintenance for checking/recording/display and retains
unexpired windows for resume. See the [hosted pause contract](hosted-contract.md#pause-and-resume). Do not infer subscriptions or hosted identity from
Maintenance. This ticket adds no pause flag or commercial policy.

## In-flight attempts

The [owner confirmed any overlap is Maintenance](https://github.com/webriot/irisbeat/issues/8#issuecomment-6867542753).
An HTTP/TCP attempt starting inside a window, or still pending when a window is
declared, records `maintenance` even if the window expires, ends early, or is
replaced before completion. The running attempt retains its own overlap flag;
changing/clearing the current window cannot erase that evidence. The existing
per-Monitor in-flight guard still prevents duplicate execution, and deletion still
discards a late result without affecting a replacement Monitor.

The observation retains its attempt-start timestamp, including when declaration
happens later. Its outcome contributes neither outage/recovery counts nor the
success/failure availability denominator. An attempt starting exactly at `endsAt`
has no overlap with that expired window and counts normally unless another window
intersects it. Open Incidents remain frozen for overlap results; only wholly
post-window results satisfy normal thresholds. No result is created for a skipped
execution. Installed-consumer tests exercise both webhook and hosted-hook
suppression when windows are replaced/ended entirely during a pending attempt and
when a successful attempt spans replacement/expiry of an open Incident's window.
