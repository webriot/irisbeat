# Hosted engine contract 1

Implements [ticket #10](https://github.com/webriot/irisbeat/issues/10) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product decisions remain in
those issues. This is an AGPL-3.0-only release candidate, not a registry publication
or production deployment. Final release/distribution remains pending under #12; see [release operations](install.md).

## Consumption

Run `npm ci`, `npm run check`, then `npm run test:consumer`. This produces
`dist/irisbeat-0.2.2.tgz` and `dist/SHA256SUMS`. The test packs twice and compares
SHA-256, resolves the exact local version in `test/consumer/package.json`, verifies
lockfile SHA-512 integrity, installs with offline `npm ci`, typechecks the installed
package and bundles its package import into a separate real workerd consumer.
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
Hosted consumers own accounts, Stripe, hostname provisioning, and Email Service provisioning. The engine provides email consent and the delivery Worker submits confirmation mail.

## Trusted adapter

`createHostedWorker(adapter)` returns Worker `fetch` and `scheduled` handlers.
The adapter supplies just:

- `resolve(request, env)`: return `{ id, permission, monitorLimit, paused?, policyRevision?, notificationOrigin? }` or `null` for
  an unrecognized host. `id` is the stable Durable Object name; `permission` is
  `editor`, `reader`, or `null` for an anonymous visitor. `monitorLimit` is a
  nonnegative safe integer. Invalid resolved contexts fail closed with 500.
  An optional `notificationOrigin` is a trusted canonical HTTPS origin for the
  context's recipient-facing pages. Leave it unset for a context without email.
- `contexts(env)`: return stable context names or `{ id, paused?, policyRevision? }` descriptors for
  this scheduled invocation. Identical duplicates are removed; conflicting pause
  state/revision metadata for the same ID rejects the invocation before dispatch. The consumer owns context discovery and
  batching; large fleets need bounded enumeration by the consumer.

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

Creation passes the adapter's allowance into the same synchronous DO operation
that checks the active collection and saves the new Monitor. Private Monitors
count; deleted ones release capacity. Lowering the allowance does not delete
existing configuration or prevent edits/checking. Hosted callers must create via
`POST /api/operator/monitors`; legacy single-Monitor saves are rejected with 400
so they cannot bypass the allowance. Page-only `PUT /api/operator` still works.
The personal default export retains its complete existing interface and unlimited
creation with the installation secret.

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
the isolated delivery Worker's consumer trigger. Use `irisbeat/notification-delivery`
as the delivery Worker entrypoint. Export `NotificationDelivery` from the hosted
monitoring Worker and bind the delivery Worker's `NOTIFICATION_DELIVERY` service
to that named entrypoint. It resolves a webhook only while the original context,
Monitor, destination and selection remain eligible. Keep the Queue and service
binding under trusted deployment control. Delivery lookup is available through
service RPC. Keep Workers Logs enabled on the delivery Worker and disable
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

HTTP, TCP and Heartbeat share post-commit Incident enqueueing. A job carries stable
event and delivery IDs, original event time and safe rendering data. Address
changes replace the destination identity and clear prior selections. A failed
enqueue logs `notification_enqueue_failed` and leaves the Incident committed.
Queue acceptance starts durable delivery. This slice makes one bounded provider
submission per message and logs `webhook_submission_failed` on failure.

Hosted and self-hosted Incident notifications require explicit Monitor selections
and the Queue and delivery Worker above. Monitoring and Incident recording
continue without `NOTIFICATION_QUEUE`. If a selected destination cannot be
enqueued because the binding is missing, the engine records the same enqueue
failure as a rejected submission.

The engine no longer invokes `onIncidentTransition` in any configuration. The
protected method and exported `IncidentTransition` type remain deprecated for
source compatibility with existing hosted subclasses. To resume sending after
upgrade, configure the Queue and delivery Worker and select destinations on each
Monitor that should send.

## Email consent

Follow the sender, Queue and service-binding configuration in
[optional email confirmation](install.md#optional-email-confirmation).
For hosted delivery wrappers, re-export `NotificationEmailCapability` from
`irisbeat/notification-delivery`. Set `ResolvedContext.notificationOrigin`
from trusted configuration. Resolve unauthenticated requests to
`/notifications/confirm` at that origin to the same context. Confirmation
credentials remain in the link's fragment until the recipient submits the form
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
Pause cancels queued jobs from previous pause generations. Target requests and
webhooks already submitted remain in flight. Resume starts with an empty
notification backlog. Maintenance #8 suppresses Incident transitions before the
engine reaches Queue handoff. Editors use `PUT`/`DELETE /api/operator/monitors/:id/maintenance`.
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

Contract 1 adds `GET /api/status/events` with `Upgrade: websocket`. Hono resolves
it through the same trusted `HostedAdapter.resolve` and context binding as
`/api/status`. Anonymous access is intentional; operator subscriptions and
credentials are outside this endpoint. The browser `Origin` must exactly match
the resolved application URL's origin, including scheme and port. Forwarded host
headers do not override it. Use HTTPS/WSS in production; HTTP/WS is accepted only
on localhost and loopback for development. Serve the engine at the trusted
application URL, and keep the existing context resolution validation.

The existing `MonitoringContext` accepts the connection through Cloudflare's
Hibernation WebSocket API. Its fixed text message `changed` means fetch the current
`/api/status` snapshot. There are no snapshots, fields, identifiers, revisions or
credentials on the socket. Only public projection changes notify: published
Monitor results/history (including Calendar Checks and finalized Heartbeat occurrences),
last-seen receipts, publication, names, visible
Incidents, Maintenance and pause. Target/timing-only settings, webhook destinations,
private Monitor activity and other contexts remain silent. Notification comparison
and send happen synchronously after persistence and before external alert delivery.

After processing a notice and completing its snapshot read, send exactly `ack`.
This acknowledges delivery only and cannot mutate monitoring data. Each socket
retains one pending notice plus one dirty bit; changes while pending collapse into
one further `changed` after acknowledgment. Attachments and the public subscription
tag survive hibernation. Unexpected messages, including unsolicited acknowledgments
and binary messages, close with 1008. The context accepts at most 128 connections;
excess upgrades return 503. No-origin/cross-origin or insecure nonlocal requests
return 403; requests without an upgrade return 426. Closed sockets are removed by
the runtime. Public Maintenance expiry and UTC history rollover use a storage alarm
while published Monitors have subscribers; no permanent server timer is needed.

Clients must subscribe **before** fetching a fresh snapshot, and repeat that read
on every reconnect. Notifications are hints, not a replay log. The public UI bounds
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
All mutations continue through existing HTTP routes. JSON shapes and contract version
remain unchanged.

Implementation references: [Cloudflare Hibernation WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [Hono upgrade middleware caveat](https://hono.dev/docs/helpers/websocket).

## Operator subscriptions

Contract 1 adds an authenticated handoff for `GET /api/operator/events`. Open a
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
current authorized `/api/operator` snapshot. Notifications use the same fixed
`changed` and `ack` protocol as public subscriptions, with one pending notice and
one dirty bit. They carry no configuration, identifiers or credentials. Operators
receive private Monitor/configuration/results/history/Incident/Maintenance/pause
changes in their context. Readers do not receive webhook-only change activity.
A permission change discards previously queued dirty activity before the client
resynchronizes. Public and other-context subscribers remain isolated.

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
