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
