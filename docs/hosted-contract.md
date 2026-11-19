# Hosted engine contract 1

Implements [ticket #10](https://github.com/webriot/irisbeat/issues/10) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product decisions remain in
those issues. This is an AGPL-3.0-only release candidate, not a registry publication
or production deployment. Final release/distribution remains pending under #12; see [release operations](install.md).

## Consumption

Run `npm ci`, `npm run check`, then `npm run test:consumer`. This produces
`dist/irisbeat-0.3.0.tgz` and `dist/SHA256SUMS`. The test packs twice and compares
SHA-256, resolves the exact local version in `test/consumer/package.json`, verifies
lockfile SHA-512 integrity, installs with offline `npm ci`, typechecks the installed
package and runs both package exports as separate Workers in local workerd,
with real Queue delivery, trusted service RPC, and locally captured Email Sending.
The package includes both Wrangler configurations as binding references. Hosted
consumers supply their own Worker names, routes, account integration and Queue resources.
The temporary consumer lockfile changes with the candidate artifact and is ignored.
A released consumer must retain its exact version and integrity lock; release operations attach the final tarball/checksum and exact source to the release without silently replacing it.

The package exports TypeScript source and includes its UI and license. A
TypeScript-aware Workers bundler (including Wrangler/esbuild) is required; it is
not a Node.js runtime library. Hono is an installed runtime dependency. For consumer
TypeScript checks, enable `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`;
the packaged page source also declares its JSX runtime for bundlers. Import `createHostedWorker`, `MonitoringContext`,
`HostedAdapter`, `EngineEnv` and `Status` from `irisbeat`.
Pin the artifact version **and literal `contractVersion: '1'`**; unsupported
versions throw during factory construction, before requests or scheduling run.
`private: true` prevents accidental registry publication; versioned GitHub release tarballs are the supported distribution path.
Hosted consumers own accounts, Stripe, hostname provisioning, and Email Service provisioning. The engine provides email consent and the delivery Worker submits confirmation and alert mail.

## Trusted adapter

`createHostedWorker(adapter)` returns Worker `fetch` and `scheduled` handlers.
The adapter supplies just:

- `resolve(request, env)`: return `{ id, permission, monitorLimit, paused?, policyRevision?, notificationOrigin? }` or `null` for
  an unrecognized host. `id` is the stable Durable Object name; `permission` is
  `editor`, `reader`, or `null` for an anonymous visitor. `monitorLimit` is a
  nonnegative safe integer. Invalid resolved contexts fail closed with 500.
  An optional `notificationOrigin` is a trusted canonical HTTPS origin for the
  context's recipient-facing pages. Leave it unset for a context without email.
- `contexts(env)`: return stable context names or `{ id, paused?, policyRevision?, notificationOrigin? }`
  descriptors for this scheduled invocation. For contexts with email, supply the
  same trusted origin as in `resolve`. Identical duplicates are removed. Conflicting
  pause metadata or origins for the same ID reject the invocation before dispatch.
  The consumer owns context discovery and batching. Large fleets need bounded
  enumeration by the consumer.

The adapter must authenticate the actor and validate the actual tenant host using
its trusted configuration. Never use a caller's tenant/role/allowance headers or
body as identity. The fixture's host/token table is test-only. Its `/test-*` routes
and clock substitution are not exported by the engine artifact.

The engine routes every page, setting, Monitor, credential, receipt and scheduled
check to that identity. Use a dedicated namespace for the hosted consumer; do not
mix its names with a personal installation. Server authorization permits readers
to inspect all active Monitors and retained Incidents, including private/deleted
history, but no writes. Anonymous responses include only published Monitors and
their Incidents. Readers never receive alert destinations; no status response,
HTML or script receives heartbeat credentials or their digests. Operator JSON adds
`hosted: true` and `permission`; the existing ledger hides editing controls for
readers and offers hosted credential rotation for editors.

The monitoring Worker's optional `MIN_CHECK_INTERVAL_SECONDS` binding applies
the same outbound check floor across all resolved contexts. Operator snapshots
include the effective Interval or Calendar suspension details. [Monitor API](monitor-api.md#outbound-check-floor)

Creation passes the adapter's allowance into the same synchronous DO operation
that checks the active collection and saves the new Monitor. Private Monitors
count; deleted ones release capacity. Lowering the allowance does not delete
existing configuration or prevent edits/checking. Hosted callers must create via
`POST /api/operator/monitors`; legacy single-Monitor saves are rejected with 400
so they cannot bypass the allowance. Page-only `PUT /api/operator` still works.
The personal default export retains its complete existing interface and unlimited
creation with the installation secret.

## Availability history

Bind `AVAILABILITY_HISTORY` as an Analytics Engine dataset on the Worker that
hosts `MonitoringContext`. Configure the self-hosted SQL inputs or supply
`AVAILABILITY_QUERY` as a trusted service binding on that Worker. The query service
and the write binding use the same Analytics Engine account and dataset. The
service binding takes precedence over the direct credentials when supplied.

Import `AvailabilityQueryService`, `AvailabilityQuery`, and `AvailabilityRow`
from `irisbeat`. The engine calls
`queryAvailability(query: AvailabilityQuery): Promise<AvailabilityRow[]>`.
The request carries an opaque `tenantKey` (the context's Durable Object ID),
a batch of 1–50 authorized `monitorIds`, and `start` and `end` in Unix
milliseconds. The service always filters by the tenant key and the listed IDs.
Filter on the actual observation timestamp and include `start`, excluding
`end`. Group by Monitor and UTC day. Return one
`{ monitorId, date, successes, failures, maintenance }` per observed day, with
`date` as `YYYY-MM-DD` and each count weighted by `_sample_interval`. Return
an empty array when no rows match and reject on read failure. For delayed public
publication, `through` maps every requested Monitor ID to its maximum captured
observation revision. Apply `double2 <= through[monitorId]` before aggregating
each Monitor. Preserve this filter when querying retained public rows after a
newer observation or visibility change. When the request
includes `observation: { at, outcome }`, add both exact filters for the
installation readiness probe. Keep this service private to trusted Worker
callers. The caller supplies identity after authorizing the public or Operator
read, and the service never accepts scopes from browser headers or URLs.

The field layout and cutover are in the
[availability history handoff](history-api.md). The readiness endpoint is
editor-only. Existing status payloads keep the 90-day history shape with an
optional `stale: true` on previously successful aggregates.

## Heartbeat credentials

An editor calls `POST /api/operator/monitors/:id/heartbeat-secret` to issue or
rotate a Heartbeat Monitor's credential. No JSON body is needed. The 200 response
`{ secret }` is the only time the credential is returned. New hosted Heartbeats
require this explicit issuance; no installation-wide credential authorizes them.
Non-Heartbeat, missing, deleted or other-context IDs return 404. Readers get 403.
The ledger displays the returned Bearer value until editing ends or sign-out.

Send `POST /heartbeat` to the trusted tenant host with `Authorization: Bearer
<secret>`. The body is never read. The digest identifies an active Heartbeat in
that context; invalid/cross-context/revoked credentials return 401. Non-POST is
405; hosted `/heartbeat/:id` is 404. Rotation stores a new SHA-256 digest and
revokes the old value before returning; receipt matching rereads after hashing
and commits synchronously before any delivery awaits. A receipt already committed
before rotation is retained. Personal `/heartbeat/:id` continues using the
installation secret and ignores bodies.

## Incident notifications

Use one Queue for the monitoring Worker's `NOTIFICATION_QUEUE` producer and
the isolated delivery Worker's consumer trigger and `NOTIFICATION_HANDOFF`
producer. Configure a second Queue in the same jurisdiction for the delivery
Worker's `NOTIFICATION_DLQ` producer. Keep native dead-letter routing unset
because it forwards the original job body. Use `irisbeat/notification-delivery`
as the delivery Worker entrypoint and bind its exported SQLite Durable Object
`NotificationRecovery` as `NOTIFICATION_RECOVERY`, with a SQLite class migration.
Export `NotificationDelivery` from the hosted monitoring Worker and bind the
delivery Worker's `NOTIFICATION_DELIVERY` service to that named entrypoint.
It resolves a webhook or confirmed inbox only while the original context,
Monitor, destination and selection remain eligible. Keep the Queue and service
binding under trusted deployment control. The same service RPC records submission
results. Keep Workers Logs enabled on the delivery Worker and disable
automatic traces because fetch spans can include credential-bearing webhook URLs.

Editors manage webhook destinations with `POST /api/operator/destinations` and
`PUT` or `DELETE /api/operator/destinations/:id`. Provide an HTTPS `{ url }` for
creates and replacements. The authenticated editor snapshot exposes `destinations`
and each Monitor's `destinationIds`. Use `PATCH /api/operator/monitors/:id`
with `{ destinationIds: [...] }` to replace the list or `{ destinationChanges: { [id]: true | false } }`
to change individual selections atomically. `true` requires a saved webhook or a confirmed inbox, `false` removes the selection if present, and omitted IDs retain
their current selection. Use one selection field per request.
A new Monitor starts with zero selections. The previous webhook setting upgrades
to an unselected destination and its compatibility endpoint manages that entry.

HTTP, TCP and Heartbeat share post-commit Incident and Maintenance enqueueing. A job carries stable
event and delivery IDs, original event time and safe rendering data. Address
changes replace the destination identity and clear prior selections. A failed
enqueue logs `notification_enqueue_failed` and leaves the change committed.
Queue acceptance starts durable delivery for webhooks, email confirmations and alert emails.
The consumer calls the trusted `resolveAlert` RPC for webhook and email alerts.
The monitoring Worker continues to support the earlier `resolveWebhook` RPC.
The delivery Worker rechecks eligibility immediately before it reserves a
submission in the delivery's SQLite Recovery object and calls the provider.
Duplicate Queue copies share a ten-submission budget, even at the same broker
ordinal. No provider call starts once the job is one hour old. Temporary
failures back off exponentially. Eligibility and Recovery RPC errors can
consume broker deliveries without spending the provider budget. Keep the broker
configured for ten retries. Its final delivery is reserved for terminal
bookkeeping and does not submit to a provider.

The Recovery object records terminal outcomes before the source is acknowledged.
Result reporting, confirmation marking and sanitized dead-letter writes then
recover independently through the object's alarm, for up to 14 days. If Recovery
is unavailable on the final broker delivery, the consumer submits a delayed,
bookkeeping-only message to the source Queue and acknowledges the original
after that write succeeds. The handoff retains the original eligibility evidence
and timestamps, omits Monitor names and addresses, and cannot submit to a provider.
If Recovery and the handoff write both fail on the final delivery, the broker
can discard the exhausted source. Settings can retain its preceding result and
the dead-letter Queue can receive no diagnostic for that job. A durable provider
reservation can consume a slot if the Worker crashes before making the request.

Editor snapshots expose the optional `destinations[].latestSubmission` with
`status`, `at` (Unix milliseconds) and a safe `reason` for failures.
A recorded acceptance closes submission while Settings or confirmation marking
is pending. An acceptance from a request already submitted is preserved even if
a newer attempt started. Exhaustion and its dead-letter diagnostic wait for
outstanding requests for that delivery identity to settle. A crash before
recording the provider outcome, or a transport timeout with unknown provider outcome, can still lead to duplicates.
Acceptance records provider submission. At equal event times, Settings uses the
order recorded with the monitoring commit. Ordered events take precedence over
legacy jobs at the same event time. Legacy jobs still use broker time and
delivery identity when compared with one another.

Confirmation eligibility uses the original invitation and pause generation.
The Recovery object stores only opaque identities, timestamps, the pause
generation needed for confirmation marking, and sanitized outcome fields.
Dead-letter diagnostics include the reserved provider attempt count and have
no automatic replay.

Hosted and self-hosted notifications require explicit Monitor selections
and the Queue and delivery Worker above. Monitoring and Incident recording
continue without `NOTIFICATION_QUEUE`. If a selected destination cannot be
enqueued because the binding is missing, the engine records the same enqueue
failure as a rejected submission.
See [Maintenance notifications](maintenance-api.md#maintenance-notifications)
for the event vocabulary and timestamps. Installations with an existing Queue
and Monitor selections must follow the [version compatibility and rollout order](install.md#upgrade-and-roll-back-notification-workers).

The engine no longer invokes `onIncidentTransition` in any configuration. The
protected method and exported `IncidentTransition` type remain deprecated for
source compatibility with existing hosted subclasses. To resume sending after
upgrade, configure the Queue and delivery Worker and select destinations on each
Monitor that should send.

## Email consent

Before enabling hosted email, turn off **Enable email preview** in
the Cloudflare sending domain's settings and keep it off while sending Irisbeat
mail. When enabled, the Activity log stores the HTML, plain text and raw message
with live confirmation or unsubscribe links for about seven days. Cloudflare still processes
recipient metadata for transport. Keep addresses and recipient links out of
Irisbeat logs and Queue diagnostics.
[Cloudflare domain settings](https://developers.cloudflare.com/email-service/configuration/domains/#email-preview)
and [Activity log message previews](https://developers.cloudflare.com/email-service/observability/logs/#message-preview).

Follow the sender, Queue and service-binding configuration in
[optional email confirmation](install.md#optional-email-confirmation).
For hosted delivery wrappers, re-export `NotificationEmailCapability` from
`irisbeat/notification-delivery`. Set `ResolvedContext.notificationOrigin`
from trusted configuration in both request and scheduled resolution. Resolve unauthenticated requests to
`/notifications/confirm` and `/notifications/unsubscribe` at that origin to the same
context. Recipient credentials remain in the link's fragment until the recipient submits the form
and are excluded from status snapshots and Queue payloads.

Editors use the same destination create and replace routes with
`{ channel: "email", address }`. Editor snapshots report `emailConfigured: true`
when email setup is available and expose email destinations as
`{ id, channel: "email", address, confirmed }`. A pending destination can
be resent via `POST /api/operator/destinations/:id/confirmation`.
Removal and replacement clear the original invitation and selections. The
five-minute cooldown is per inbox within the context. Confirmation requires an
explicit POST, is single-use, and expires 24 hours after the invitation is
created. It does not change Monitor selections or replay Monitor events.
A paused context can save pending inboxes. Resume requires an explicit resend
and never releases a confirmation queued before pause.

Alert mail includes the Monitor name, original event time and safe Incident or
Maintenance details in HTML and plain text. The unsubscribe link remains valid at
the origin where it was issued until the destination is removed or replaced.
The recipient can withdraw while monitoring is paused. The explicit POST removes
only that context's destination and its selections and invalidates queued alerts
that have yet to be submitted. On upgrade from the confirmation-only build, the
engine uses the trusted context origin to create missing withdrawal credentials
before scheduled dispatch while preserving consent and Monitor selections.
Cloudflare owns SMTP processing after provider acceptance.

The Queue uses `NotificationQueueJob` for both regular Monitor jobs and jobs
with `kind: "email.confirmation"`. The latter resolve the inbox and its link
through trusted `NotificationDelivery` RPC using the current invitation
identity and pause generation.

## Pause and resume

[#11](https://github.com/webriot/irisbeat/issues/11) extends contract 1 additively.
`ResolvedContext` and exported `ScheduledContext` accept either omitted policy or
`{ paused: boolean, policyRevision: number }`. Each explicit pause/resume requires
both fields. `policyRevision` is a nonnegative safe integer from the trusted
per-context policy source, atomically read with `paused`. Missing, null, fractional,
negative, unsafe or nonnumeric revisions, nonboolean state, and revision without
state fail closed (request 500; scheduled invocation rejects). Undefined/omitted
**both** fields and legacy string scheduled IDs preserve persisted policy.

The consumer owns one durable increasing revision sequence per context ID, shared
by request resolution and scheduled discovery across all isolates. Advance it when
publishing a new policy snapshot; never reuse a revision for another state, reset
it on process/deployment restart, or derive it from wallclock time, request order,
cron timestamps or an isolate-local counter. Both fields must come from one atomic
source record; reading them separately can produce a conflicting pair. Gaps are
allowed. Policy revisions order policy snapshots, independently of Monitor edits,
permissions, scheduling time and the engine's internal delivery generation.

The DO compares and persists revision plus state synchronously in one operation:

- Older revision: ignore the stale policy; continue using persisted state.
- Same revision/same state: idempotent, with no detector reset.
- Same revision/conflicting state: reject without changing stored policy (request
  500; scheduled invocation rejects before that context's check).
- Higher revision/same state: advance the revision without resetting counts,
  recovery spacing or in-flight delivery generation.
- Higher revision/changed state: apply it. Only actual resume resets counts/spacing.

After trusted host/actor resolution, a consumer can return these shapes from one
policy record (example revision 42). The next actual resume must use a higher
source revision, such as 43:

```ts
// resolve(request, env), after trusted identity/permission/allowance resolution:
return { id, permission, monitorLimit, paused: policy.paused, policyRevision: policy.revision };
// contexts(env), for the same trusted context and source record:
return [{ id, paused: policy.paused, policyRevision: policy.revision }];
// To omit policy propagation, retain the other resolved fields or a legacy ID:
return { id, permission, monitorLimit }; // resolve
return [id]; // contexts
```

Identical scheduled descriptors are deduplicated; duplicates with differing state,
revision, or omission reject the invocation before any context dispatch. Other
contexts are independent; a persisted-policy conflict in one context cannot roll
back already accepted work in another. Already captured stale snapshots may finish
in either order: the persisted source revision protects against stale request
resolution, scheduled discovery and concurrent arrivals, including after restart.

Callers' headers, bodies and operator permissions cannot pause/resume a context.
An anonymous request can carry trusted adapter policy without acquiring editing
permission. The test fixture's policy queries and external resolution gates are
absent from the engine artifact. Send policy changes on a resolved request or
enumerate that context with explicit metadata; removing it from enumeration does
not pause it. The engine cannot enforce a policy change it has not yet received.

Pause state survives eviction/restart. Status and mutation responses add context
`paused: boolean`; visible Monitor `state` becomes `paused`, overriding Maintenance
while retaining the window, prior last result, history and configuration. Public
and operator ledgers show “Monitoring paused”, including an empty collection.
No personal pause endpoint, subscription state or pause button is added.

Paused HTTP/TCP schedules dispatch no attempts. Paused scheduled Heartbeat silence
evaluations produce nothing. Authorized Heartbeat receipts still return 204 and
persist last-seen, without changing last result, detector progress, observations,
bars, percentage or Incidents. Existing credentials, rotation, tenant isolation,
publication and editing rules remain in force. Previously recorded history remains
unchanged; a day with only paused activity is empty.

Resume zeros failure/success counts and Heartbeat recovery count/spacing; it retains
due times, last-seen, prior results and Incidents. No synthetic result or replay is
created. A fresh Heartbeat stays free of a new outage; an existing Incident still
requires normal recovery receipts. A stale producer opens through the next normal
silence evaluation. Unexpired Maintenance takes effect again; expired windows do
not resume. Checks wholly after resume follow existing due-time rules.

Any pending HTTP/TCP attempt touched by pause is discarded even if resumed before
completion. Its original due-time anchor and in-flight guard remain in force.
Before each provider submission attempt, the delivery Worker checks eligibility
through the trusted service binding. The monitoring context rejects jobs while
paused and rejects jobs from an earlier pause generation, including when both
pause and resume happened between attempts. Resume creates no notification
backlog. Target requests and provider submissions already in flight cannot be
recalled. A policy update can race with provider submission after the eligibility
check, since they are separate operations. Maintenance #8 suppresses Incident
transitions before the engine reaches Queue handoff. Editors use
`PUT`/`DELETE /api/operator/monitors/:id/maintenance`.
See [Maintenance handoff](maintenance-api.md) for status
fields, observation retention, and the #11 precedence seam. Installed-consumer
coverage verifies Queue suppression for all three check kinds.
[History #9](history-api.md) adds the same filtered per-Monitor series to personal and hosted status, including readers; it does not change credentials, permissions, allowances or delivery. The release candidate must be
regenerated after integration changes, before #12 publishes anything.

### HTTP and TCP Calendar compatibility

Contract 1 also accepts HTTP/TCP `scheduleMode`, `cron` and `timezone` through the same authorized collection routes as personal installations. Existing consumers and omitted fields remain Interval-compatible. `/api/operator/schedule-preview` requires editor permission and returns authoritative explanation/three future instants without mutation. Calendar configuration is operator-only; private/public visibility and allowances are unchanged. Persisted pause skips occurrences, and resume anchors at the next future occurrence without catch-up Checks or observations. Calendar Maintenance uses the existing observation exclusion and transition suppression. See [Calendar API](monitor-api.md#http-and-tcp-calendar-schedules).

### Calendar Heartbeat compatibility

Contract 1 also accepts Calendar Heartbeats through the existing authorized collection and legacy configuration routes. Calendar mode adds `graceSeconds` and uses occurrence-based recovery; Interval behavior and omitted fields remain compatible. The operator preview accepts optional `graceSeconds` and rejects overlapping receipt windows using the same validator as saves. Reader/editor permissions, allowance checks, tenant credential rotation and anonymous visibility remain unchanged.

Receipts use the same authenticated `POST /heartbeat`, ignore bodies and persist last-seen immediately. Per-occurrence evidence and chronological finalization survive object recreation and credential rotation. Receipt freshness and every committed catch-up outcome invalidate the appropriate public/operator projection before alert delivery; pending invalidations coalesce, and private Monitors remain silent to public subscribers. Each scheduled invocation processes at most 128 expired occurrences per Monitor; following invocations resume the durable cursor. Pause skips occurrences without observations; resume starts at the next future occurrence while retaining unexpired Maintenance and open Incidents. Calendar/grace changes isolate generations. No backfill precedes Calendar enablement, and old outcomes never insert out-of-retention observations. See [Calendar Heartbeat integration](heartbeat-api.md#calendar-heartbeats) for inclusive deadlines, durable Maintenance evidence, detector progress and best-effort transition delivery.

## Public subscriptions

Open `GET /api/status/events/v2` with `Upgrade: websocket`. Hono resolves the
same trusted context as `GET /api/status`. The browser `Origin` must exactly
match the application's origin, including scheme and port. Use HTTPS/WSS in
production. HTTP/WS is accepted on localhost and loopback for development.

The Durable Object sends JSON text hints through hibernating WebSockets:

```json
{"type":"changed","revision":42,"scopes":["monitor/9b0dceda-7dac-4c39-899c-c997af760151","banner","incidents"]}
```

The scope names are `page`, `banner`, `monitors`, `monitor/<id>`,
`incidents`, and, for editors, `destinations`. A single row scope identifies
one visible Monitor. `monitors` replaces the ordered ledger for membership
changes, pause, or UTC rollover and supersedes individual row scopes in a
coalesced hint. Public hints cover published Monitor data and visible Incidents,
Maintenance, page settings and pause. Public Monitor IDs already appear in the
anonymous snapshot. Reader hints also cover private Monitor activity in their
context. Only editor hints include destination and selection changes.

For each hinted scope, fetch
`GET /api/status/partials/<scope>?revision=<revision>` or its authorized
`/api/operator/partials/<scope>` counterpart. Hono returns `{ revision, html }`
plus Operator permission and the metadata needed to update actions and preserve
drafts. A gone or invisible row returns empty HTML, as does an unknown row.
An inaccessible section returns 404. A successful response has a revision at
least as high as the requested minimum (409 if unavailable). The default
minimum is zero. Each partial uses the current request's trusted tenant and
permissions. Operator partials bypass shared caches. Public partials use the
published Status revision and a regional edge cache.

After processing a notice and its reads, send exactly `ack`. Each socket holds
one pending hint and a coalesced successor covering the union of queued scopes
at the newest revision. More than 32 queued rows collapse into `monitors`.
Attachments survive hibernation. Unexpected messages, including unsolicited
acknowledgments and binary messages, close with 1008. Each context accepts at
most 128 public connections. Excess upgrades return 503, invalid Origin or
insecure nonlocal requests return 403, and a request without an upgrade returns
426. Maintenance expiry and UTC rollover use a storage alarm while there are
relevant subscribers and are also detected on reads.

Subscribe before fetching a fresh snapshot, and repeat that read on every
reconnect. The full snapshot recovers changes missed while disconnected.
The public UI bounds
reads to one active request and one queued refresh, ignores an intermediate response
when another refresh is queued, and aborts reads after ten seconds. It preserves
existing row nodes, history selection and focus. Reconnect delays increase from
one second to at most thirty seconds (including jitter), with a ten-second handshake
deadline. Disconnected visible pages poll every sixty seconds and show Polling;
connected pages stop fallback polling. A failed read retains the last snapshot and
shows Updates unavailable with Retry, including when the first read fails. Visibility
return and Retry fetch immediately without reloading. Retry stays disabled while
pending; only a successful snapshot read clears the failure. Recovery is announced
and moves focus from the removed Retry control to the page heading.
Page exit closes the connection, and returning from the browser page cache resubscribes.
All mutations continue through existing HTTP routes with their established JSON
shapes. Hosted adapter contract version remains `1`.

Implementation references: [Cloudflare Hibernation WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [Hono upgrade middleware caveat](https://hono.dev/docs/helpers/websocket).

## Operator subscriptions

The authenticated subscription uses `GET /api/operator/events/v2`. Open a
same-origin WebSocket, then obtain `POST /api/operator/events/ticket` using the
same authorization as `GET /api/operator`. The personal Worker checks the
installation Bearer secret; hosted Workers call `HostedAdapter.resolve` on every
ticket request, including renewal. Both readers and editors can obtain tickets;
null permission returns 401. The response is uncached JSON `{ ticket, expiresAt }`.
Tickets are random, expire **30 seconds after issuance**, and are consumed once by
an atomic Durable Object operation. They are bound to the resolved context,
operator audience, exact application origin and resolved reader/editor permission.

The **first** socket message must be JSON `{ "type": "auth", "ticket": "…" }`.
Before it succeeds, the socket receives no notifications, including private
activity. Success returns the fixed text `authorized`; immediately fetch the
current authorized `/api/operator` snapshot. Operator sockets use the same
scoped JSON hint and `ack` protocol. A permission change discards previously
queued scopes before the client resynchronizes. Public and other-context
subscribers have independent streams.

Authorization lasts at most **five minutes from ticket issuance**, enforced by
server alarms and checked before every operator message or notification. Obtain
a fresh HTTP-authorized ticket before expiry and send
`{ "type": "renew", "ticket": "…" }` on the **same socket**. `authorized` confirms
the new lease and permission scope; fetch another authorized snapshot. The supplied
browser renews after four minutes. Renewal does not require reconnecting. Invalid,
reused, expired, wrong-origin or wrong-context tickets, wrong first messages and
expired leases close with 1008. An expired lease cannot be revived by renewal.

These durations are application authorization policy, not Hono or Cloudflare
connection limits. Hosted role changes/revocation take effect on the next HTTP
request; an already issued ticket/lease can permit notifications until its
five-minute deadline. Consumers must resolve current permissions on each ticket
issuance and must not cache authorization beyond their intended revocation policy.
There is no push revocation hook or account/session infrastructure in this public
engine. A consumer requiring immediate server-side account revocation must arrange
that separately; snapshot reads and every mutation always retain independent
request-time authorization and existing reader/editor projections. Socket messages
cannot mutate application state or bypass monitor allowances.

The trusted URL origin and HTTPS/WSS rules match public subscriptions; no Origin,
a cross-origin browser, or insecure nonlocal upgrade returns 403. Forwarded host
headers never override the application origin. Serve the Worker at the trusted
application origin, and validate host/context identity in the hosted adapter.
Upgrade query strings and WebSocket subprotocols are rejected with 400. Never put
installation secrets, account bearer credentials, or tickets in socket URLs,
protocols, logs or persistent browser storage. Only the short-lived ticket crosses
the socket, inside an authentication/renewal message; browser credentials and
tickets remain in memory. The ticket endpoint checks Origin when supplied so
non-browser authenticated consumers can also use the handoff.

Each context bounds operator sockets to 128, including at most 16 awaiting
authentication, and pending tickets to 128. Excess requests return 503. An
unauthenticated socket must authenticate within ten seconds. Attachments retain
audience, context, origin, permission, expiry and coalescing state across
hibernation. A shared storage alarm handles authorization deadlines, Maintenance
expiry and UTC history rollover; private deadlines never wake public subscribers.
Closed sockets are cleaned up by the runtime, expired tickets are pruned on the
next issuance, and consumed tickets are deleted immediately.

The operator browser shares reconnect/backoff, visible-page polling fallback,
failure-only Retry, visibility resynchronization and bounded coalescing with the public page.
It preserves drafts, focus, open menus, selected history days and Monitor
validation. Failed snapshots retain the last view with Updates unavailable and Retry;
successful writes alone do not clear a failed-read indicator.
Sign-out or authorization loss closes the socket, stops renewal/reconnect/polling,
and clears private UI state. Session guards reject late ticket and snapshot
responses. Consumer UIs must implement the same teardown on sign-out and denied
renewal; they must not leave a valid lease running after local authorization loss.
All writes continue through existing authorized HTTP routes.

### Committed revision and publication handoff

Each Durable Object keeps independent increasing public, reader and editor
revisions. Each affected audience advances once in the same SQLite transaction
as the changed state. Separate counters prevent a public or reader client from
inferring hidden activity from revision gaps. A revision is meaningful within
its trusted context and audience. It is independent of hosted policy revision.

`MonitoringContext.publishViewChanges(hints)` is the synchronous post-commit
hook for committed changes. Each entry is a `ViewHint` containing the committed
revision and affected resources for its audience. In delayed mode, hosted
overrides forward public hints from `onStatusPublished(hint)`. In immediate
mode they can forward them from `publishViewChanges`. `readView(scope, audience)` returns
projection input and its committed revision together. Hono owns the HTML
rendering. The availability provider is consulted only for ledger or row reads.
The internal Operator configuration, Maintenance, and destination RPCs return the editor revision and affected
scopes. The bundled clients request `Accept: application/vnd.irisbeat.view+json`
for full refreshes of `/api/status` and `/api/operator`. Hono renders those
refreshes with the same components as the scoped resources. Bundled Operator
writes use the same header and receive `{ revision, scopes }` after commit.
The browser fetches those scopes over authenticated HTTP immediately, including
when its WebSocket is disconnected. A failed partial refresh triggers a full
read. Legacy clients retain the existing JSON reads and mutation responses
without the media type.

Public publication coalesces revisions and scopes in a durable pending record.
`STATUS_RENDER_INTERVAL_SECONDS` defaults to 60. Positive values through 86,400
set a UTC-aligned window. An explicit `"0"` opts into immediate public
rendering. Use the same binding in the HTTP Worker and the MonitoringContext
Worker when they are configured separately. Invalid values fall back to 60
seconds and log `invalid_status_render_interval`.

With public subscribers, the subscription alarm wakes at the next publication
boundary. The Hono render functions prepare the affected partials and the
MonitoringContext saves the public projection. The synchronous protected
`onStatusPublished(hint)` hook then receives the coalesced public hint. Call
`super.onStatusPublished(hint)` to retain built-in WebSocket delivery. An
override can read the prepared partials through `readPublishedStatus(scope,
hint.revision)`. The saved projection supports those reads after eviction.
Reader and editor hints still follow their committed revisions immediately.

With no public subscribers, the first GET after the boundary renders the latest
elapsed publication and invokes the same hook. At rollover, the
MonitoringContext retains the elapsed window's public inputs, revision, and
scopes before a newer write can affect them. When several windows elapse
without a render, publication uses the latest eligible inputs and carries
forward the affected scopes. Maintenance expiry and UTC history rollover take
effect in the windows containing their expiry time and midnight, respectively,
even if discovered later. Before the first delayed change, the
MonitoringContext saves the prior public inputs so even a first-ever GET within
the window sees the pre-change Status. Entering immediate mode discards the
old delayed publication and pending hints. Returning to delayed mode starts
from the current state. An unpublish can take the same window to appear on
anonymous Status. Operator authorization, Check commits, and alert handoff
stay independent of the public window.

Cloudflare's Cache API stores anonymous documents, snapshots, and partials
regionally. The MonitoringContext resolves the eligible publication revision
before the HTTP Worker looks up a cache entry. The key includes the trusted
Durable Object ID, resource, publication revision, and render generation, so ordinary GETs catch up
even when an edge clock differs from the publication clock or a client missed a
hint. A hinted revision is a lower bound on the same URL. An edge miss renders
the published projection and an unavailable minimum returns 409. Static assets
and the generic Operator shell use content-based keys. Client-facing responses
retain `Cache-Control: no-store`. Hosted deployments can bind
`IRISBEAT_VERSION` using Wrangler version metadata to isolate Status entries by
deployed Worker version. See [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
and [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

#### Availability in a public publication

The MonitoringContext seals an elapsed window before a later change can alter
its Monitor set, Incidents, observation revisions or UTC history range. A later
open window retains its own pending changes. Maintenance expiry and UTC rollover
use their effective time when discovered after idle periods. The MonitoringContext queries before
rendering, persisting the projection, and sending the public hint. An observation
committed later stays outside that series even if its observation timestamp is
in the published range. Check commits, notification handoff and Operator
authorization proceed independently of the query.

`statusPublicationRevision(resource?, minimum?)` resolves the eligible revision
and render generation before an edge lookup. `readPublishedStatus(resource,
minimum)` reads the prepared render with the same version fields. A scoped
retry GET can revalidate a stale, pending or unavailable row even on a warm
edge. The MonitoringContext records a per-row retry deadline. An ordinary GET
after that deadline can revalidate the unresolved rows it reads even after the
browser finishes its four retries. Successful changes persist the corrected
series and advance the render generation together. All anonymous representations
use the resulting generation. The public hint revision and the publication
window still control when new Monitor state and visibility become public.

### Upgrade from unscoped subscriptions

Deploy the Worker and its bundled browser assets together. The documents
reference `?live=2` browser scripts and the scoped sockets use the `/events/v2`
paths. Legacy upgrade paths return 404. Pre-upgrade tabs recover over the
existing snapshot polling; reloading loads the scoped client. The Durable Object
closes incompatible hibernated attachments with 1012 when it next inspects them.
Existing state starts at revision zero and remains readable. Run
`node test/upgrade.cjs --live-views` with Chromium installed to verify both
browser generations across an actual Worker bundle swap.
