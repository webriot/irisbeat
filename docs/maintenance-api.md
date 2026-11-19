# Maintenance

Use a Maintenance window to mark planned downtime on a Monitor. Irisbeat
continues evaluating checks and excludes Maintenance from availability and
Incident detection.

## Controls and status

- `PUT /api/operator/monitors/:id/maintenance` accepts `{ "endsAt": <epoch milliseconds> }`.
  Starts immediately using server time; a changed end time replaces the one
  existing window. Saving the existing end time leaves its window intact. End time
  must be a safe integer in the future within the JavaScript Date range.
- `DELETE /api/operator/monitors/:id/maintenance` ends early. Repeating it after
  expiry/end is harmless and does not reset subsequent detector progress.
- Both require installation Bearer authorization, use the existing bounded JSON
  reader for PUT, return full operator status, and return 404 for deleted/unknown IDs.
  HTTP, TCP and Heartbeat share these routes. Windows start immediately.
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
changing due times, last-seen, last result, availability, or Incidents. Delayed
Watchdog silence observations use their scheduled timestamp to determine whether
they fall inside a naturally expired window. During Maintenance, Interval
Heartbeat receipts refresh last-seen and record Maintenance, including closely
spaced receipts. Recovery follows the Monitor's usual rules after the window.
Calendar Heartbeats [exclude entire overlapping receipt windows](heartbeat-api.md#calendar-heartbeats).

## Availability history

Executed observations are submitted to Analytics Engine with their event
timestamp. Outbound checks use attempt start. Heartbeat receipts, actual silence
evaluations and finalized Calendar windows follow their respective timestamps.
Entering or ending Maintenance and skipped executions create no observations.
Maintenance is recorded as its own outcome and excluded from the
success/failure denominator. See the [availability history contract](history-api.md).

## Hosted permissions and pause

Hosted editors can set or end Maintenance. Readers can see active windows.
A paused context takes precedence over Maintenance and retains any unexpired
window for resume. See the [hosted pause contract](hosted-contract.md#pause-and-resume).

## Maintenance notifications

Maintenance uses the same [delivery queue and destination checks](hosted-contract.md#incident-notifications)
as Incident notifications. `MaintenanceNotificationEvent` is part of
`NotificationEvent`. It carries the Monitor name, original event time (`at`), and the window's
`startedAt` and scheduled `endsAt`, all timestamps in epoch milliseconds.

| Event kind | Additional detail |
| --- | --- |
| `maintenance.started` | `at` is the declaration time |
| `maintenance.updated` | `previousEndsAt` records the replaced end time |
| `maintenance.ended` | `reason` is `early` or `expired`. For expiry, `at` is the scheduled end even when evaluated later |

Expiry clears the persisted window once. Scheduled evaluation can clear it and
enqueue its end without status traffic or subscriptions. A paused context
suppresses Maintenance notifications, and the trusted delivery lookup applies
the same selection and pause checks used for Incident jobs.

## In-flight attempts

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
execution.
