# Hosted engine contract 1

Implements [ticket #10](https://github.com/webriot/irisbeat/issues/10) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product decisions remain in
those issues. This is an AGPL-3.0-only release candidate, not a registry publication
or production deployment. Final release/distribution remains pending under #12; see [release operations](install.md).

## Consumption

Run `npm ci`, `npm run check`, then `npm run test:consumer`. This produces
`dist/irisbeat-0.1.0.tgz` and `dist/SHA256SUMS`. The test packs twice and compares
SHA-256, resolves the exact local version in `test/consumer/package.json`, verifies
lockfile SHA-512 integrity, installs with offline `npm ci`, typechecks the installed
package and bundles its package import into a separate real workerd consumer.
The temporary consumer lockfile changes with the candidate artifact and is ignored.
A released consumer must retain its exact version and integrity lock; release operations attach the final tarball/checksum and exact source to the release without silently replacing it.

The package exports TypeScript source and includes its UI and license. A
TypeScript-aware Workers bundler (including Wrangler/esbuild) is required; it is
not a Node.js runtime library. Import `createHostedWorker`, `MonitoringContext`,
`HostedAdapter`, `EngineEnv`, `Status` and `IncidentTransition` from `irisbeat`.
Pin the artifact version **and literal `contractVersion: '1'`**; unsupported
versions throw during factory construction, before requests or scheduling run.
`private: true` prevents accidental registry publication; versioned GitHub release tarballs are the supported distribution path.
No Accounts, Stripe, hostname provisioning or email transport is included.

## Trusted adapter

`createHostedWorker(adapter)` returns Worker `fetch` and `scheduled` handlers.
The adapter supplies just:

- `resolve(request, env)`: return `{ id, permission, monitorLimit, paused?, policyRevision? }` or `null` for
  an unrecognized host. `id` is the stable Durable Object name; `permission` is
  `editor`, `reader`, or `null` for an anonymous visitor. `monitorLimit` is a
  nonnegative safe integer. Invalid resolved contexts fail closed with 500.
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

## Transition delivery and siblings

Export a subclass of `MonitoringContext<YourEnv>` with
`protected async onIncidentTransition(event: IncidentTransition): Promise<void>`.
Bind the consumer's MONITORING namespace to that exported subclass, with the same
SQLite migration as the public app. The default hook does nothing. Each committed
opening/recovery invokes it independently of publication, alongside the unchanged
webhook path; HTTP, TCP and Heartbeat use the same detector. The event contains the
opaque Durable Object `contextId`, complete `incident`, `transition` and observation
`at`. Map tenant names with `env.MONITORING.idFromName(name).toString()`; never
infer identity from a Monitor name. Events omit targets and destination/heartbeat
credentials. The consumer owns bounded delivery and any queue/outbox/recipient
mapping. Hook exceptions log only `transition_delivery_failed`, never undo the
Incident, and do not retry/reopen it. Webhooks retain their own ten-second bound.
Both paths remain best effort: a crash after commit can lose delivery; concurrent
transitions can arrive out of order. Use Incident ID plus transition for deduping.

`src/index.ts` adds small seams around existing handlers, DO creation, heartbeat
authorization and post-commit delivery. The detector and webhook transport remain
owned here. TCP integration retains the three-kind target union, atomic DO-side patch validation,
first-Monitor identity pinned before reading legacy bodies and immutable kinds.
Subsequent siblings should preserve the allowance argument on `create`,
operator response metadata, secret-safe status views and this post-commit hook
when merging their target union/atomic patch validation. Relevant paths are the
existing collection API plus the two hosted heartbeat paths above.

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
Already submitted target requests/webhooks/consumer hooks cannot be recalled;
their transport remains bounded by the existing attempt/delivery contract. A hook
waiting behind a submitted webhook is suppressed if pause intervenes, even after
resume. No missed alert is replayed. Pause alone emits no transition event and
never fabricates Incident recovery.
Maintenance #8 returns from shared `record` before Incident mutation and both
`deliverWebhook` and `onIncidentTransition`; the hosted hook must never bypass that
guard. Editors use `PUT`/`DELETE /api/operator/monitors/:id/maintenance`; readers
cannot mutate windows. See [Maintenance handoff](maintenance-api.md) for status
fields, observation retention, and the #11 precedence seam. Installed-consumer
coverage verifies suppression of both delivery paths for all three check kinds.
The hook observes committed detector transitions, not every raw observation.
[History #9](history-api.md) adds the same filtered per-Monitor series to personal and hosted status, including readers; it does not change credentials, permissions, allowances or delivery. The release candidate must be
regenerated after integration changes, before #12 publishes anything.


## Public Status subscriptions

[#30](https://github.com/Webriot/irisbeat/issues/30) adds
`GET /api/status/subscribe` with `Upgrade: websocket` to contract 1. The existing
trusted `resolve` runs for this request, including host validation and pause
policy propagation; callers cannot choose a context via query, body or headers.
Unrecognized hosts remain 404. Public subscriptions are anonymous even when an
operator credential accompanies the handshake. Private Monitors, targets, webhook/heartbeat credentials,
policy revisions and other contexts never appear in this channel.

The resolved context's `MonitoringContext.fetch` accepts a hibernating socket
with the `public` tag. Subclasses inherit `fetch`, `webSocketMessage`,
`webSocketClose`, `webSocketError` and `alarm`; consumers overriding those handlers
must forward engine subscriptions and the engine's alarm to `super`.
The engine owns the context alarm for independent public/operator Maintenance expiry and UTC
history rollover, plus operator authorization expiry. No new binding or migration is required. Forward WebSocket
upgrades through the consumer's host/proxy and preserve the response's `webSocket`
when wrapping responses. Requests without an upgrade return 426; non-GET returns
405. A context permits 256 simultaneous public sockets, returning 503 above that
application limit. HTTP snapshots remain available.

The only server frame is the literal JSON `{"type":"status-changed"}`. It has no
revision, timestamp, context/Monitor identifier, snapshot or delta. Notifications
occur only when the public projection changes (including publication, page name,
visible observations/history/Incidents, Maintenance and pause). Comparisons use a
fixed instant throughout each synchronous mutation stage, including state reads
and expiry processing, so unrelated private writes cannot trigger a clock
notification. Notification equality uses committed public observation counts,
independently of fallible presentation history queries. History failure/recovery
alone is silent; snapshots still return null series and log query failures. Real
committed-comparison storage errors propagate rather than becoming empty history.
Clock alarms depend only on published data, and public writes preserve overdue
clock deadlines for the independent clock path. Target/timing-only
edits, private observations, webhook saves, credential rotation and unchanged
policy revisions remain silent. Public Heartbeat freshness is part of the existing
snapshot, including receipts during pause, so changes to published `lastSeen`
notify even when history remains frozen.

Clients must fetch `GET /api/status` immediately on open/reconnect and after a
notification, then send the literal text `resync` **after** the read completes.
Each socket retains at most one outstanding notification plus a dirty bit; changes
while its read is in flight cause one more notification after `resync`. This
closes the snapshot/subscription race without a replay log. Any other client frame
closes with 1008 and cannot write application data. Pending/dirty attachments
survive hibernation. Runtime/deployment disconnects require a new connection and
snapshot; no persisted revision or in-memory baseline is required.

The supplied public UI uses one snapshot read plus one coalesced trailing read,
a 15-second snapshot deadline, a 250-ms acknowledgement delay, a 10-second socket
handshake deadline and reconnect delays capped at 30 seconds (1, 2, 4, 8, 16, 30).
While disconnected it polls every 60 seconds only while visible; connection and
visibility return reconcile immediately. A failed subscription snapshot restarts the connection so recovery does not
require another public change. Socket failure alone does not mark data
stale: failed snapshot reads retain the last ledger and show “Updates unavailable”.
Page exit clears timers, aborts its read and closes its socket; persisted-page
return reconnects. Writes stay on HTTP. Both views use the same connection lifecycle and retain the existing operator refresh/draft path. Theme, keyboard history selection, dates and keyed DOM identity remain
owned by the existing presentation/reconciler.

Implementation follows Cloudflare's [hibernating WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
and [Durable Object state APIs](https://developers.cloudflare.com/durable-objects/api/state/),
verified against the installed Workers types and workerd runtime tests.


## Operator subscriptions

[#31](https://github.com/Webriot/irisbeat/issues/31) extends contract 1 additively;
existing adapters need no new hook, binding, migration, or identity infrastructure.

1. Authenticate `POST /api/operator/subscription` through the existing trusted
   `resolve`. A reader or editor receives JSON `{ ticket }`; anonymous requests
   receive 401 and other methods receive 405. Personal installations use their
   existing installation Bearer secret on this HTTP request only.
2. Connect to `GET /api/operator/subscribe?ticket=…` with a WebSocket upgrade.
   The capability is scoped to the resolved context, exact request origin, and
   reader/editor audience captured at issuance. It expires after 15 seconds and
   is consumed synchronously once, including across object recreation. Missing,
   expired, replayed, wrong-context, or wrong-origin tickets receive 401. The
   anonymous endpoint always remains public and cannot consume this capability.
3. Fetch the existing authorized `GET /api/operator` on open, reconnect and each
   notification, then send `resync` after reading. Every snapshot and HTTP write
   still passes through current `resolve` permission checks. Reader snapshots
   omit editor secrets; readers cannot mutate. No socket frame can request a
   snapshot or perform a write. Frame shape/coalescing match the public channel.
4. Renew by repeating the authenticated HTTP handoff after socket closure.
   Tickets, authorization headers and installation secrets belong only in memory;
   never put long-lived credentials in socket URLs/protocols or browser storage.
   The engine's error logging uses pathnames, excluding ticket queries. Consumers
   should redact ticket queries in their own access logging and telemetry.

Socket authorization is a **bounded lease**, ending 60 seconds after ticket
issuance (not redemption). Changes to permission, session validity, or installation
credentials may take up to the remainder of that lease to stop notifications.
This is the explicit revocation bound, not immediate push revocation: a consumer
requiring immediate revocation needs an additional trusted invalidation design.
Until expiry, the socket retains its issuance audience. Expiry closes it with
4001, even with no snapshot requests or incoming frames. The independent alarm
survives hibernation; every notification and acknowledgement also checks expiry,
so a delayed alarm cannot send private activity past the deadline. Current HTTP
authorization is required for renewal; denial signs the supplied UI out and clears
privileged data/drafts, closes sockets, cancels pending handoffs and ignores late
responses. Permission downgrades reconcile through current reader snapshots,
clearing editor forms and secrets and replacing the old audience subscription. Ordinary reconnects preserve unsaved edits.
Consumers must make `resolve` reflect their current trusted session/permission
state on handoff and snapshot requests; the engine never persists their account
credentials or implements their session infrastructure.

Operator comparisons use the same fixed operation instant and committed history
facts as public comparisons, but include private Monitors, targets/timing,
retained Incidents, Maintenance and pause. Webhook-only changes notify editors
only, since readers' projection excludes the destination. Credential rotation,
unchanged facts/policy revisions and presentation history failures stay silent.
Each context allows 256 reader and 256 editor sockets, and at most 256 unexpired
handoff tickets (503 at capacity). Attachments retain only pending/dirty flags and
authorization deadline. Tickets retain only capability, origin, audience and
expiry deadlines. No shared revision or operator activity enters the public
channel. Independent public and operator clock deadlines share the single DO
alarm by scheduling their minimum together with authorization expiry; a private
subscription/change/expiry cannot consume or replace a public clock deadline.

The operator UI shares reconnect/backoff, immediate resync, notification
coalescing, 15-second snapshot reads, 10-second handoffs/handshakes and visible
60-second disconnected polling with the public UI. All mutations remain HTTP.
Rendered runtime/browser tests cover draft and focus retention, history selection,
menus, themes, signout and reconnection; workerd tests cover capability boundaries,
lease expiry without reads, recreation, audience/context isolation and public
notification timing regressions. The packed consumer fixture verifies inheritance,
reader/editor handoffs and projection isolation using the installed package.
