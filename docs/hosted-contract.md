# Hosted engine contract 1

Implements [ticket #10](https://github.com/webriot/irisbeat/issues/10) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). Product decisions remain in
those issues. This is an AGPL-3.0-only release candidate, not a registry publication
or production deployment. Final release/distribution belongs to #12.

## Consumption

Run `npm ci`, `npm run check`, then `npm run test:consumer`. This produces
`dist/irisbeat-0.1.0.tgz` and `dist/SHA256SUMS`. The test packs twice and compares
SHA-256, resolves the exact local version in `test/consumer/package.json`, verifies
lockfile SHA-512 integrity, installs with offline `npm ci`, typechecks the installed
package and bundles its package import into a separate real workerd consumer.
The temporary consumer lockfile changes with the candidate artifact and is ignored.
A released consumer must retain its exact version and integrity lock; #12 should
attach the final tarball/checksum to the release without silently replacing it.

The package exports TypeScript source and includes its UI and license. A
TypeScript-aware Workers bundler (including Wrangler/esbuild) is required; it is
not a Node.js runtime library. Import `createHostedWorker`, `MonitoringContext`,
`HostedAdapter`, `EngineEnv`, `Status` and `IncidentTransition` from `irisbeat`.
Pin the artifact version **and literal `contractVersion: '1'`**; unsupported
versions throw during factory construction, before requests or scheduling run.
`private: true` prevents accidental registry publication while #12 is pending.
No Accounts, Stripe, hostname provisioning or email transport is included.

## Trusted adapter

`createHostedWorker(adapter)` returns Worker `fetch` and `scheduled` handlers.
The adapter supplies just:

- `resolve(request, env)`: return `{ id, permission, monitorLimit }` or `null` for
  an unrecognized host. `id` is the stable Durable Object name; `permission` is
  `editor`, `reader`, or `null` for an anonymous visitor. `monitorLimit` is a
  nonnegative safe integer. Invalid resolved contexts fail closed with 500.
- `contexts(env)`: return the stable context names to check for this scheduled
  invocation. Duplicates are removed. The consumer owns context discovery and
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

Pause is **not implemented by this ticket**. #11 should extend this context adapter
and shared DO detector with the spec's explicit pause/resume semantics; merely
omitting an ID from `contexts()` does not implement pause (receipts still detect
and no paused banner/reset exists). No pause flag or claim is exposed here.
Maintenance #8 returns from shared `record` before Incident mutation and both
`deliverWebhook` and `onIncidentTransition`; the hosted hook must never bypass that
guard. Editors use `PUT`/`DELETE /api/operator/monitors/:id/maintenance`; readers
cannot mutate windows. See [Maintenance handoff](maintenance-api.md) for status
fields, observation retention, and the #11 precedence seam. Installed-consumer
coverage verifies suppression of both delivery paths for all three check kinds.
The hook observes committed detector transitions, not every raw observation.
History remains its own ticket. The release candidate must be
regenerated after integration changes, before #12 publishes anything.
