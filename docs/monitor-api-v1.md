# Monitor configuration API v1

On a self-hosted installation, send `Authorization: Bearer <write API key>`
or use the installation secret as the Bearer credential. Every Monitor
configuration operation requires Write access, including list and read by ID.
The routes return `401` for missing, invalid, expired, or revoked credentials
and `403` for Read API keys. Hosted Workers return `404` for these routes.
See the [automation API overview](api-v1.md) for key administration and the
shared authentication response format.

| Method and path | Success | Response |
| --- | --- | --- |
| `GET /api/v1/monitors` | `200` | `{ "monitors": [...] }` with all active Monitor configurations in creation order, including private Monitors |
| `POST /api/v1/monitors` | `201` | Created Monitor and a relative `Location` header containing its resource path |
| `GET /api/v1/monitors/:id` | `200` | Saved Monitor, including changes made in the Operator |
| `PATCH /api/v1/monitors/:id` | `200` | Updated Monitor |
| `DELETE /api/v1/monitors/:id` | `204` | Empty body |

Monitor IDs are opaque and remain fixed throughout updates. Unknown and
deleted IDs return `404`. Deletion stops checks and preserves the Monitor's
Incidents in the Operator view. Unsupported methods return `405` with an
`Allow` header.

## Monitor fields

Each Monitor response is a JSON object with these fields. Only fields
applicable to the saved kind and schedule are present.

| Field | Type | Applies to |
| --- | --- | --- |
| `id`, `name` | String | All Monitors |
| `kind` | `"http"`, `"tcp"`, or `"heartbeat"` | All Monitors |
| `published` | Boolean | All Monitors |
| `scheduleMode` | `"interval"` or `"calendar"` | All Monitors |
| `recoveryThreshold` | Integer | All Monitors |
| `destinationIds` | Array of strings | All Monitors, including an empty array for an unassigned Monitor |
| `url` | String | HTTP |
| `hostname`, `port` | String, integer | TCP |
| `intervalSeconds` | Integer | HTTP, TCP, and Interval Heartbeat |
| `timeoutSeconds`, `failureThreshold` | Integer | HTTP and TCP |
| `cron`, `timezone` | String | Calendar |
| `silenceSeconds`, `recoverySpacingSeconds` | Integer | Interval Heartbeat |
| `graceSeconds` | Integer | Calendar Heartbeat |

The response contains saved configuration. Publication controls public
visibility independently of whether checks run. `destinationIds` contains
the currently assigned IDs. An HTTP or TCP Calendar Monitor keeps a saved
`intervalSeconds` value for use when switching back to Interval. The
[status API](api-v1.md#monitor-status) serves status, Incidents, and availability
history.

## Create and update

Send a JSON object with `Content-Type: application/json`. The request body
limit is 4 KiB. Unsupported media types return `415`. Larger bodies return
`413` with an empty body. Malformed JSON and invalid configuration return
`400` and leave configuration intact. Body errors have the JSON shape
`{ "error": "message" }`, except for `413`.

Creation requires a nonblank `name` of at most 120 characters. `kind` defaults
to `"http"`, `published` to `true`, and `scheduleMode` to `"interval"`.
Provide an HTTP(S) `url` without embedded credentials for HTTP. Provide a DNS
name or IP `hostname` and an integer `port` from 1 to 65,535 for TCP.
Heartbeats have no target. Calendar requires a `cron` expression and defaults
`timezone` to `"UTC"`.

PATCH requires at least one configuration field. Omitted fields generally keep
their saved values. An unchanged `kind` is accepted. To switch back to Interval,
send `{ "scheduleMode": "interval" }` and leave out `cron` and `timezone`.
When switching to Calendar, include the cron expression and optionally a
timezone. `id`, `destinationIds`, and `destinationChanges` are rejected in
request bodies. Use the Operator to change assignments.

See the [HTTP and TCP timing rules](monitor-api.md#http-and-tcp-checks),
[Calendar rules](monitor-api.md#http-and-tcp-calendar-schedules),
[installation check floor](monitor-api.md#outbound-check-floor), and
[Heartbeat timing rules](heartbeat-api.md#configure-a-heartbeat) for accepted
values and defaults. The API returns normalized saved values. For example,
HTTP URL fragments are dropped and TCP DNS names are lowercased.
