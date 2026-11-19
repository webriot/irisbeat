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
  stale?: true; // last successful query, pending or after an unsuccessful refresh
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

After committing an observation, the MonitoringContext submits one Analytics
Engine data point. The dataset contains these Irisbeat fields:

| Column | Value |
| --- | --- |
| `index1` | Opaque Durable Object ID. Stable for the context in its namespace. |
| `blob1` | Opaque Monitor ID. |
| `blob2` | `success`, `failure`, or `maintenance`. |
| `double1` | Actual observation time in Unix milliseconds. |

HTTP and TCP use attempt start. Watchdog Heartbeats use the receipt or silence
evaluation time. Calendar Heartbeats use the completed window deadline even if
dispatch was delayed. Queries filter on that timestamp and group by its UTC day.
Each outcome count sums Analytics Engine's `_sample_interval`. Maintenance
contributes to its own count and is excluded from availability. Paused contexts
submit no observations. Cloudflare controls retention and asynchronous ingestion.
See [Workers Analytics Engine SQL and sampling](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

A read uses only visible, active Monitor IDs from the current context. Successful
daily aggregates are cached in the context for 60 seconds and refreshed on a
new observation or UTC day change. Query errors leave the last usable aggregates
visible as stale, including after Durable Object eviction. Without cached data
a failed read yields unavailable history. Before any new observation, a configured
Monitor has an empty series. History may lag current status while an observation
is being ingested or the cached totals age out. Status, detection, Incidents,
and notification handoff commit independently of query availability.

The first activation of the new build drops the previous SQLite raw observations
table and indexes. There is no backfill. Monitor configuration, latest results,
detection progress, Maintenance and Incidents are preserved. Rolling the code back
cannot restore the retired rows.

## Integration

The full Status and Operator read paths use
`MonitoringContext.status(operator, secrets)`. Scoped reads use
`MonitoringContext.readView(scope, audience)`. The context queries only active
Monitors in the authorized ledger or row. Public reads include only published
Monitors. Mutation responses carry cached history, empty bars, or unavailable
history without waiting for a query. Observations and mutations produce scoped
hints from committed state. Renders preserve the `stale` flag with the series.

See [installation and readiness](install.md#availability-history) for self-hosted
configuration and [the trusted query interface](hosted-contract.md#availability-history)
for managed deployments.
