# Availability history handoff

Implements [#9](https://github.com/webriot/irisbeat/issues/9) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product policy and the
owner-selected Status ledger remain in those issues and #2.

## Responses and rendering

Existing status and operator endpoints, including mutation responses and the
legacy first-Monitor alias, add `monitor.history`:

```ts
history: {
  days: Array<{
    date: string; // YYYY-MM-DD UTC, oldest first, exactly 90 entries
    state: 'up' | 'down' | 'degraded' | 'maintenance' | 'empty';
    successes: number;
    failures: number;
    maintenance: number;
  }>;
  percentage: number | null; // 0–100, unrounded; null means no denominator
  stale?: true; // last successful query while a refresh is needed
  pending?: true; // recent or deferred observations may be absent from the totals
} | null; // unavailable with no usable cached result
```

Exported types are `HistoryDay` and `AvailabilityHistory`. The range is today
plus the previous 89 UTC calendar days. Both endpoints and the ledger share this
range. Public filtering happens before series reads, so private/deleted Monitors
never acquire public bars. Hosted readers receive the operator view with unchanged
secret filtering and no editing controls. The UI formats a counted percentage to
two decimals. An empty denominator displays “No observations”. Unavailable
history displays “Bars unavailable”. A stale result keeps the bars and shows
“Availability history is stale”. Each strip has one keyboard entry point with arrow-key navigation and touch
selection. Both views label the range “past 90 days”. Selected days show compact
successful/failed counts and Maintenance counts when present; unobserved days
remain “No observations”. Historical dates stay explicit in UTC. “Exact time
range” expands the UTC midnight boundaries and browser-local endpoints with
timezone, while bar accessibility descriptions retain the full state and counts.
Selection and expanded ranges survive automatic updates and operator refreshes;
public selection is kept in the current browser history entry. Operator bars span
the ledger width beneath their Monitor row; Incidents follow the ledger.

Public Incidents have `openedAt < next UTC midnight` and either no recovery or
`closedAt > first displayed UTC midnight`. Recovery exactly at the range start
does not overlap. Within each group, Incidents remain newest first
(`openedAt DESC`, ID tie-break),
with exact UTC instants in machine-readable timestamps and browser-local display
times. The ledger separates Ongoing and Resolved Incidents, showing Monitor,
status, start, recovery when present, and elapsed duration. Ongoing durations
advance with the runtime page clock independently of snapshot freshness. Current
date/time and timezone appear once at page level; historical and cross-day
Incident endpoints retain dates. Durations use elapsed instants across daylight
saving changes. Operators receive all retained Incidents, including older and
deleted-Monitor names, with a Deleted Monitor marker; missing recovery remains
ongoing after deletion. No page-wide percentage is added.

## Writes, reads and cutover

The MonitoringContext stores every eligible observation in a SQLite outbox in
the same transaction as the latest result, detector state and any Calendar
cursor advancement. The transaction also arms the shared Durable Object alarm.
Scheduled dispatch, Heartbeat receipt handling and the alarm use the same
bounded drain once those writes are durable. Scheduled dispatch shares the
[250-point invocation limit](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
across its contexts and Monitors. Each alarm invocation drains up to 250
points and schedules a subsequent wakeup before handing off the batch.
The outbox contains only pending points and drops entries that age out of
the displayed window.

Irisbeat removes a point from the outbox when `writeDataPoint()` returns
without throwing. At that point the binding has accepted the point for
asynchronous processing. The call returns no ingestion receipt, so durable
ingestion and query visibility remain unconfirmed. A synchronous error keeps
the point queued. If execution stops after the binding accepts a point but
before the outbox deletion commits, a retry can submit a duplicate and affect
the aggregate totals. See [Cloudflare's Analytics Engine binding example](https://developers.cloudflare.com/workers/examples/analytics-engine/).

The dataset contains these Irisbeat fields.

| Column | Value |
| --- | --- |
| `index1` | Opaque Durable Object ID. Stable for the context in its namespace. |
| `blob1` | Opaque Monitor ID. |
| `blob2` | `success`, `failure`, or `maintenance`. |
| `double1` | Actual observation time in Unix milliseconds. |
| `double2` | The Monitor observation revision assigned at commit. |

HTTP and TCP use attempt start. Watchdog Heartbeats use the receipt or silence
evaluation time. Calendar Heartbeats use the completed window deadline even if
dispatch was delayed. Queries filter on that timestamp and group by its UTC day.
Each outcome count sums Analytics Engine's `_sample_interval`. Maintenance
contributes to its own count and is excluded from availability. Paused contexts
record no new observations. Previously committed points can still drain.
Cloudflare controls retention and asynchronous ingestion.
See [Workers Analytics Engine SQL and sampling](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

Operator and immediate reads use only visible, active Monitor IDs from the current context. Successful
daily aggregates are cached in the context for 60 seconds and refreshed on a
new observation or UTC day change. While observations are queued or in the
two-minute window following handoff, successful aggregates remain eligible for
refresh after 15 seconds. Aggregates are eligible for a fresh read at the end
of the window even if a read ran shortly before it. Query errors use the latest
usable scoped cache, including after Durable Object eviction. A current result
from an overlapping successful read stays fresh. Without cached data a failed
read yields unavailable history. Before any new observation, a configured
Monitor has an empty series. History may lag current status while an observation
is being ingested or the cached totals age out. Connected, visible pages retry
only affected rows, every 30 seconds, up to four attempts while a row stays
pending, stale, or unavailable. Status, detection, Incidents,
and notification handoff commit independently of query availability.

The first activation with both the write binding and query configuration drops
the previous SQLite raw observations table and indexes. Retained SQLite Status renders and their series are invalidated. Readiness reports
whether an observation can be read back. Transient SQL failures do not delay
activation or monitoring. There is no backfill. Monitor configuration, latest results,
detection progress, Maintenance and Incidents are preserved. Rolling the code back
cannot restore the retired rows.

## Integration

Operator reads use `MonitoringContext.status(operator, secrets)` and
`MonitoringContext.readView(scope, audience)`. Mutation responses carry cached
history, empty bars, or unavailable history without waiting for a query.
Delayed Status reads query only Monitors from the eligible publication. Each
series is limited to the observation revision and UTC range captured for that
publication. Renders preserve `stale` and `pending` flags. History-only recovery
advances the render generation independently of the public revision and updates
the cache keys for the Status page, JSON, negotiated snapshot, ledger and row.

See [installation and readiness](install.md#availability-history) for self-hosted
configuration and [the trusted query interface](hosted-contract.md#availability-history)
for managed deployments.
