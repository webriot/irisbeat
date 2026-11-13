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
} | null; // missing/failed series query
```

Exported types are `HistoryDay` and `AvailabilityHistory`. The range is today
plus the previous 89 UTC calendar days. Both endpoints and the ledger share this
range. Public filtering happens before series reads, so private/deleted Monitors
never acquire public bars. Hosted readers receive the operator view with unchanged
secret filtering and no editing controls. The UI formats a counted percentage to
two decimals; null percentage displays “Unavailable”, null history displays
“Bars unavailable”. Each bar exposes its UTC date, state and observation counts
to assistive technology and a title tooltip. Operator bars span the ledger width
beneath their Monitor row; Incidents follow the ledger.

Public Incidents have `openedAt < next UTC midnight` and either no recovery or
`closedAt > first displayed UTC midnight`. Recovery exactly at the range start
does not overlap. Incidents remain newest first (`openedAt DESC`, ID tie-break),
with UTC times. Operators receive all retained Incidents, including older and
deleted-Monitor names. No page-wide percentage is added.

## Storage and failure boundary

The #8 observation writer is unchanged in meaning: attempt-start timestamps,
any-overlap Maintenance classification, actual receipts/silence evaluations, no
synthetic scheduler results or pre-upgrade backfill. A separate protected
`queryHistory(id, start, end)` performs bounded-range daily SQL aggregation;
returning null or throwing only makes that Monitor's series unavailable. It does
not suppress current state or Incident reads. The test-only Worker subclass
substitutes this query through a test request endpoint; that endpoint and fixture
are absent from the distributed engine and production Worker.

Indexes cover `(monitorId, at)`, global observation age, and Incident ordering.
Each executed observation deletes at most 1,000 observation rows strictly before
the current 90-day UTC range, using the later of execution/server time so delayed
completion cannot move the cutoff backward. Cleanup never deletes current/future
days or any Incident. Idle contexts may retain expired observations until later
execution; these rows are excluded from queries. Old backlogs drain over subsequent
observations. Retention is deliberately limited to observations outside the
specified display range; operators' Incident archive remains unbounded, as
required. There is no older raw-observation API or configurable retention policy.

## Pause #11 and distribution #12

Pause must prevent calls to the shared observation writer while retaining
Heartbeat freshness. No row means no bar count or percentage denominator; do not
record a failure, Maintenance, or synthetic paused observation. Resume must retain
existing observations. This ticket adds no subscription policy or pause controls.
Preserve the #8 any-overlap classification before the history writer.

Regenerate the local candidate artifact after integrating this change. The package
includes this handoff and remains AGPL-3.0-only. No registry publication, deployment,
or live sends are needed for verification.
