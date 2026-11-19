# Monitor API and scheduling

Use this API to configure a self-hosted installation. See the [hosted contract](hosted-contract.md)
for hosted identity, permissions, and subscription protocols.

## Requests and responses

Send `Authorization: Bearer <installation secret>` with Operator API requests.
For JSON request bodies, send `Content-Type: application/json` and stay within
4 KiB. Monitor IDs are opaque and never reused. The API returns 404 for unknown
or deleted IDs and 405 with an `Allow` header for unsupported methods.

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Read the public status page data. |
| `GET /api/operator` or `GET /api/operator/monitors` | Read full Operator status. |
| `PUT /api/operator` | Set the page name with `{ pageName }`. |
| `POST /api/operator/monitors` | Create a Monitor. Returns 201 and full Operator status. |
| `PATCH /api/operator/monitors/:id` | Edit a Monitor. Returns 200 and full Operator status. |
| `DELETE /api/operator/monitors/:id` | Stop monitoring and remove the configuration. Returns 200 and retains Incidents for operators. |
| `POST /heartbeat/:id` | [Send a Heartbeat receipt](heartbeat-api.md#send-a-receipt). |

Creation requires a `name`. Omit `kind` for HTTP and provide an HTTP(S) `url`
without embedded credentials. For `kind: "tcp"`, provide a DNS name or IP address
as `hostname` and an integer `port` from 1 to 65,535. A `kind: "heartbeat"`
Monitor has timing settings and no target. Set `published: false` to keep a
new Monitor private. The default is `true`.

When editing, send only the fields you want to change. A TCP hostname or port
can be updated independently. Changing the Monitor kind or sending target or
timing fields for a different kind returns 400 and leaves configuration intact.
See [HTTP and TCP timing](#http-and-tcp-checks) and [Heartbeat timing](heartbeat-api.md#configure-a-heartbeat)
for the supported fields.

To select alert destinations, add them in Operator Settings and edit the
Monitor. Via API, use `destinationIds` to replace the entire selection or
`destinationChanges` with a map from destination ID to `true` or `false` to
update individual selections. See [notification destinations](hosted-contract.md#incident-notifications).

Public responses include published Monitors and their publicly visible
Incidents. Monitor fields include `id`, `name`, `kind`, `state`, `lastResult`,
[availability history](history-api.md#responses-and-rendering), and `lastSeen`
for Heartbeats. Operator responses also include private Monitors, publication
settings, targets, and kind-specific timing. Editors receive `destinations`,
Monitor `destinationIds`, and the compatibility field `webhookUrl`.
Both responses share the following fields.

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

### Compatibility routes

Existing clients can send page and Monitor fields together via
`PUT /api/operator` to update the first active Monitor or create one if the
list is empty. If that first Monitor changes before the save commits, the
request returns 409 and changes neither page nor Monitor settings. Reload
before retrying. Use `monitors[]` and ID-specific routes for new clients.

`GET /api/operator/webhook` also returns full Operator status. Send
`{ url }` to `PUT /api/operator/webhook` to set the legacy webhook, or
`{ url: "" }` to remove it.

The Monitor array contains active configuration only. Deleted Monitor names
remain on Incidents in the Operator view. Publication controls public visibility.
Private Monitors continue checking and can send alerts to selected destinations.

Related endpoints and interfaces are documented in
[Maintenance](maintenance-api.md#controls-and-status),
[availability history](history-api.md#responses-and-rendering),
[history readiness](install.md#availability-history),
[notification destinations](hosted-contract.md#incident-notifications),
[email consent](hosted-contract.md#email-consent),
[public subscriptions and partials](hosted-contract.md#public-subscriptions),
and [Operator subscriptions and partials](hosted-contract.md#operator-subscriptions).

## HTTP and TCP checks

HTTP checks send a GET, follow redirects, and succeed on a 2xx response. TCP
checks succeed when a plain connection opens, without testing TLS or an
application protocol. Network errors and timeouts count as failures. New
Monitors show **Awaiting check** until the first observation. Scheduled dispatch
runs once a minute.

| Field | Range | Default |
| --- | --- | --- |
| `intervalSeconds` | Installation's [outbound check floor](#outbound-check-floor) through 86,400 seconds | 60 seconds with the default floor |
| `timeoutSeconds` | 1–60 seconds | 10 seconds |
| `failureThreshold` | 1–100 consecutive failures to open an Incident | 2 |
| `recoveryThreshold` | 1–100 consecutive successes to close an Incident | 2 |

The API accepts whole numbers for these fields. Operator duration controls
allow seconds, minutes, hours, or days, including fractions that convert to
whole seconds. A day in a duration is 86,400 seconds.

Omitted timing fields keep their saved values. Changing an interval recalculates
the next due time from the most recent attempt's start. Changing the thresholds
keeps the counts and applies to subsequent attempts. An in-flight attempt uses
its starting target, timeout, and thresholds and records its result without
overwriting newer settings. Timing edits alone never open or resolve an Incident.

## Persistence and upgrades

Monitor configuration, detector progress, due times, and Incidents persist in
SQLite-backed Durable Object storage. ID-specific edits validate and commit
against the current Monitor, so a partial target edit keeps the other fields.
Deleting a Monitor discards in-flight results and retains its Incidents.

Legacy single-Monitor data migrates on first access. The migration preserves the
Monitor's ID, timing, detector progress, and Incidents, and makes the Monitor
published. A saved legacy webhook becomes an unselected destination. Single-Monitor
bundles cannot read the migrated collection. See the [upgrade instructions](install.md#operate)
before changing a deployed version.

## HTTP and TCP Calendar Schedules

Use `scheduleMode: "calendar"` with a numeric five-field `cron` expression
and a named `timezone` (UTC by default). The fields are minute, hour,
day of month, month, and day of week. Wildcards, comma-separated lists,
inclusive ranges, and positive steps are supported. A step from a single
number runs from that number to the maximum. Sunday is 0 or 7.

- If neither day field contains an asterisk, either day may match. For
  example, `0 9 15 * 1` runs at 09:00 on the 15th of the month or on Mondays.
- If either day field contains an asterisk, both must match. Steps still
  apply. For example, `0 9 */2 * 1` runs at 09:00 on Mondays that fall on
  odd-numbered dates.
- When the clocks move forward, skipped local times do not run. When the
  clocks turn back, a repeated local time runs only on its first occurrence.
- Invalid cron, impossible dates, and invalid timezones return 400 without
  changing saved settings.

Editors can preview a schedule with `POST /api/operator/schedule-preview`
and `{ cron, timezone?, after? }`. The optional `after` is an instant in
epoch milliseconds and defaults to now. The response includes `cron`,
`timezone`, an `explanation`, and three `occurrences` after that instant.
The endpoint previews only. It never changes settings or dispatches checks.

A new or changed schedule starts at the next future occurrence. A delayed
dispatch runs one check for the overdue schedule and advances to the next
future occurrence. Monitor identity, last results, availability, and open
Incidents survive schedule edits. Consecutive counts reset, and results
from older in-flight attempts cannot advance the new schedule's counts.
Hosted resume also starts at the next future occurrence.

Omit `scheduleMode` on edit to keep the saved mode. Older Monitors default to
Interval. To switch to Interval, send `scheduleMode: "interval"` without
`cron` or `timezone`. The previously saved `intervalSeconds` is retained
unless you replace it. [Calendar Heartbeats](heartbeat-api.md#calendar-heartbeats)
use the same schedule fields with receipt windows.

## Outbound check floor

`MIN_CHECK_INTERVAL_SECONDS` applies across the installation. [Installation
settings](install.md#outbound-check-floor) describe its bounds and failure behavior.

- Authenticated Operator snapshots expose `minCheckIntervalSeconds`. For HTTP/TCP
  Interval Monitors, `intervalSeconds` stays the saved value and
  `effectiveIntervalSeconds` is the larger of that value and the floor.
  New outbound Interval Monitors default to the floor when the interval is
  omitted. Explicit lower values return 400, including in legacy saves. Omit
  `intervalSeconds` to keep an existing saved Interval while editing other fields.
- For HTTP/TCP Calendar Monitors, `scheduleSuspended` reports whether the
  saved Calendar is suspended. When true, `scheduleSuspensionFloorSeconds`
  gives the floor that caused suspension. New or explicitly submitted outbound
  Calendars must have every occurrence at least the floor apart, including
  timezone offset transitions. Send `outbound: true` to apply the floor in the
  schedule-preview endpoint. Calendar Heartbeat previews can omit
  `graceSeconds` or supply it to validate the grace window.
- Omit `scheduleMode`, `cron` and `timezone` from unrelated edits to keep a
  Calendar suspended. Explicitly saving a compatible schedule resumes at the
  next future occurrence and preserves observations and Incidents.
  When a delayed outbound Calendar dispatch would put a following occurrence
  inside the floor, the scheduler skips that occurrence and returns to the Calendar.
  The scheduler enforces the floor using actual start times and retains scheduled
  timestamps for observations.

These fields belong to the Operator projection. Public availability and
Incidents still reflect observations. Heartbeat retains its existing fields,
receipt windows and silence timing.
