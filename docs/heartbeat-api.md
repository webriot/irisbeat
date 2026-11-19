# Heartbeat Monitors

A Heartbeat Monitor checks whether a job or service sends receipts on time.
Choose **Interval** to detect silence or **Calendar** to expect one receipt
after each scheduled time.

## Configure a Heartbeat

In the Operator view, select **New Monitor**, choose **Heartbeat**, set its
schedule, and save. Via the [Monitor API](monitor-api.md), create it with
`POST /api/operator/monitors` and a body containing `name` and
`kind: "heartbeat"`. Use `PATCH /api/operator/monitors/:id` to edit timing or
publication. Omitted fields keep their saved values.

### Interval mode

| Field | Default | Purpose |
| --- | --- | --- |
| `intervalSeconds` | 60 | How often the producer is expected to check in |
| `silenceSeconds` | 180 | How long a Monitor may go without a receipt before Irisbeat opens an Incident |
| `recoveryThreshold` | 2 | How many qualifying receipts resolve an Incident |
| `recoverySpacingSeconds` | 60 | Minimum time between qualifying recovery receipts |

The seconds fields accept integers from 60 to 86,400. The recovery count accepts
1 to 100. Creation time starts the initial silence countdown. The scheduled
evaluation checks elapsed time against `silenceSeconds`. An accepted receipt
updates last-seen time. Receipts closer together than the recovery spacing
refresh last-seen without advancing the recovery count or restarting the spacing
timer. A later silence evaluation clears recovery progress. Edits apply to later
receipts and evaluations.

## Send a receipt

In a self-hosted installation, reopen **Edit** to find the Monitor's check-in
path. When your job completes, send an HTTPS request with the authorization header shown below.

```http
POST /heartbeat/<monitor-id>
Authorization: Bearer <installation secret>
```

The body is ignored. A successful receipt returns HTTP 204. Missing or incorrect
authorization returns 401. With valid authorization, an unknown, deleted, or
non-Heartbeat Monitor returns 404. Store the installation secret in your job's
secret configuration and send it in the authorization header.

Hosted Heartbeats use a Monitor-specific, rotatable credential and
`POST /heartbeat`. See the [hosted credential reference](hosted-contract.md#heartbeat-credentials).

## Calendar Heartbeats

Use `scheduleMode: "calendar"`, a five-field `cron` expression, and a named
`timezone` (default UTC). Calendar Heartbeats use the
[same cron and daylight saving rules as outbound schedules](monitor-api.md#http-and-tcp-calendar-schedules).
Set `graceSeconds` from 1 to 86,400 (default 30). Grace must be shorter than
every gap between occurrences, including gaps shortened by timezone changes.
Set `recoveryThreshold` from 1 to 100 (default 2). Interval expectation, silence,
and recovery spacing fields apply only in Interval mode.

Each occurrence has a receipt window from the scheduled time through the
inclusive grace deadline. One authenticated receipt satisfies the window.
Early, late, and duplicate receipts update last-seen but do not satisfy
another window or advance recovery. The next scheduled evaluation after the
window closes records availability at the deadline. One missed occurrence opens
an Incident. The configured number of consecutive successful occurrences
resolves it.

A delayed evaluation processes up to 128 expired windows per Monitor in time
order. The next evaluation resumes where it left off, including after restart.
Older missed windows still affect Incidents. Availability records only
observations in the displayed 90 UTC days.

Any overlap with [Maintenance](maintenance-api.md) excludes the whole window,
including when Maintenance starts at its deadline. Maintenance ending exactly
at the scheduled time does not overlap. Maintenance between windows resets
recovery at the time it occurred.

Creation, a change to the schedule or grace period, and hosted resume start at
the next future occurrence. They clear pending receipts and recovery progress
while keeping the Monitor ID, last result, last-seen time, and Incidents.
Ordinary edits preserve pending receipts. Credential rotation preserves already
accepted receipts. Hosted pause skips observations while allowing receipts to
update last-seen. Unexpired Maintenance carries through resume.

## History and alerts

Private Monitors continue to accept receipts, evaluate their schedule, and send
alerts to selected destinations. Deleting a Monitor stops receipt processing and
retains its Incidents in the Operator view. Public responses for published
Monitors include last-seen time and omit timing settings and credentials.
Incident notifications use the [notification queue](hosted-contract.md#incident-notifications).
