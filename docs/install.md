# Personal installation and release operations

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/webriot/irisbeat)

The button uses the public repository's default branch. Use the exact-source
CLI path below to install a specific release.

Sign into your own Cloudflare and GitHub/GitLab accounts. Choose a new repository
and an unused Worker name. Set a unique random `INSTALLATION_SECRET` in the secret
prompt (`openssl rand -hex 32` generates one locally). Keep it in a password manager.
The empty `.dev.vars.example` declares the prompt; never accept an empty value.
Keep the default build command `npm run build` (local bundle validation) and deploy
command `npm run deploy` (actual upload). The Wrangler configuration supplies the
SQLite `MonitoringContext` binding/migration, Analytics Engine write binding,
one-minute cron and workers.dev URL.
No external database, identity service, custom hostname, email or billing integration
is required. Cloudflare account limits and charges apply, including DO usage.

This follows Cloudflare's documented [Deploy button configuration](https://developers.cloudflare.com/workers/platform/deploy-buttons/),
including `cloudflare.bindings` descriptions and secret example files. Account
permissions, repository authorization and the actual build form still require a
real install drill. The button deploys the monitoring Worker only. For a complete
webhook installation, use the per-install Queue and delivery Worker setup below.
Provide `AVAILABILITY_API_TOKEN` at the secret prompt, then complete
[availability history setup](#availability-history). Do not put a credential
in Wrangler vars or a repository.

## Outbound check floor

Set the optional `MIN_CHECK_INTERVAL_SECONDS` variable on the monitoring Worker
to a whole number of seconds from 60 through 86,400. For example, use
`"vars": { "MIN_CHECK_INTERVAL_SECONDS": 300 }` in the installation's Wrangler
configuration. Omit it for the 60-second default.

The Worker validates the setting at entry. An invalid value returns HTTP 500
with an `invalid_configuration` log entry and causes scheduled invocations to
fail before dispatch. Dry-run bundling does not execute this validation.

Existing HTTP/TCP Interval Monitors use the larger of the saved interval and the
floor. Lowering the floor restores eligible saved intervals. An incompatible
HTTP/TCP Calendar is suspended until an Operator saves a compatible schedule.
The Operator ledger shows these changes in Schedule, alongside the last observed
State. Heartbeat scheduling continues to use its own timing rules.

## Exact-source CLI installation

Requires Node >=22.12, npm, a Cloudflare account and its workers.dev subdomain.
Download the source archive, `release.json`, and `SHA256SUMS` from your chosen
[GitHub release](https://github.com/Webriot/irisbeat/releases). Verify that the
manifest's full revision is the one you intend to deploy.
For an unpublished candidate, use the artifacts produced by `release:prepare`
from its reviewed Git revision instead of a release download.
Download the engine tarball as well so the checksum command can verify every
listed file. The commands below use 0.4.3 as an example. Use the version you
downloaded.

```sh
sha256sum --check SHA256SUMS
tar -xzf irisbeat-0.4.3-source.tar.gz
cd irisbeat-0.4.3
npm ci
npm run check
npm run build
npx wrangler login
npx wrangler whoami
```

Select the intended account using `CLOUDFLARE_ACCOUNT_ID` in the shell, outside
this repository, if more than one account is available. Choose names unique in
that account for this installation's two Workers and two Queues. For a fresh or
disposable install, verify that the names are unused before provisioning. Do not
use a temporary claim account.

```sh
IRISBEAT_WORKER_NAME="irisbeat-my-install"
IRISBEAT_DELIVERY_WORKER_NAME="${IRISBEAT_WORKER_NAME}-delivery"
IRISBEAT_QUEUE_NAME="${IRISBEAT_WORKER_NAME}-notifications"
IRISBEAT_DLQ_NAME="${IRISBEAT_QUEUE_NAME}-dead-letter"
npx wrangler queues create "$IRISBEAT_QUEUE_NAME"
npx wrangler queues create "$IRISBEAT_DLQ_NAME"
```

In your local extracted source, set the following Wrangler values to the shell
variable values above. Keep deployment-specific configuration out of version control.

| File | Field | Value |
| --- | --- | --- |
| `wrangler.jsonc` | `queues.producers[0].queue` | `IRISBEAT_QUEUE_NAME` |
| `wrangler.delivery.jsonc` | `queues.consumers[0].queue` | `IRISBEAT_QUEUE_NAME` |
| `wrangler.delivery.jsonc` | `queues.producers[0].queue` (`NOTIFICATION_DLQ`) | `IRISBEAT_DLQ_NAME` |
| `wrangler.delivery.jsonc` | `queues.producers[1].queue` (`NOTIFICATION_HANDOFF`) | `IRISBEAT_QUEUE_NAME` |
| `wrangler.delivery.jsonc` | `services[0].service` | `IRISBEAT_WORKER_NAME` |

Keep the binding names, `NotificationDelivery` entrypoint and migrations from
the reviewed configs. Leave the source Queue's native dead-letter routing unset
so only the delivery Worker's sanitized diagnostics reach the dead-letter Queue.
Each install needs its own Queue because Cloudflare
allows one active consumer per Queue.
See [Cloudflare's Queue setup instructions](https://developers.cloudflare.com/queues/get-started/#connect-the-consumer-worker-to-your-queue).

For the first upload, create a private temporary directory and generate the
installation secret into a JSON file readable only by your user. These commands
use Node's cryptographic random generator and do not print the secret:

```sh
IRISBEAT_SECRET_DIR="$(mktemp -d)"
export IRISBEAT_SECRET_FILE="$IRISBEAT_SECRET_DIR/installation.json"
node --input-type=module <<'NODE'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.IRISBEAT_SECRET_FILE,
  JSON.stringify({ INSTALLATION_SECRET: randomBytes(32).toString('hex') }),
  { mode: 0o600, flag: 'wx' });
NODE
```

Open that file locally and save the `INSTALLATION_SECRET` value in your password
manager; you need it to sign in and configure producers. Keep it out of terminal
recordings, source control and shell command arguments. Add the
`AVAILABILITY_API_TOKEN` to the same protected JSON file with a local editor.
Set `AVAILABILITY_ACCOUNT_ID` to the selected Cloudflare account's 32-character ID.
See [availability history setup](#availability-history) for the required token
permissions and dataset. For a fresh installation, deploy the monitoring Worker
and both secrets together. After that succeeds, deploy the consumer so its
service binding can resolve the monitoring Worker.

```sh
npm run deploy -- --name "$IRISBEAT_WORKER_NAME" --secrets-file "$IRISBEAT_SECRET_FILE" --var "AVAILABILITY_ACCOUNT_ID:$AVAILABILITY_ACCOUNT_ID" &&
  npm run deploy -- --config wrangler.delivery.jsonc --name "$IRISBEAT_DELIVERY_WORKER_NAME"
```

After deployment succeeds and the secret is saved in your password manager,
remove the temporary copy:

```sh
rm -- "$IRISBEAT_SECRET_FILE"
rmdir -- "$IRISBEAT_SECRET_DIR"
unset IRISBEAT_SECRET_FILE IRISBEAT_SECRET_DIR
```

Use the pinned local Wrangler; `--secrets-file` is supported by its installed help.
`.dev.vars` is for local development and is not uploaded as a deployed secret.
For later rotation, `npx wrangler secret put INSTALLATION_SECRET --name "$IRISBEAT_WORKER_NAME"` prompts privately
and immediately deploys a version. Rotation affects all personal producers and
operator sessions at once; update them together. A missing/empty installation
secret fails closed for administration and receipts.

## Operate

Open `/operator`, sign in, save the Status page name and add HTTP(S), TCP or
Heartbeat Monitors. Publish selected rows. The anonymous `/` and `/api/status`
show published rows only. Changes can take up to 60 seconds to appear. Set
`STATUS_RENDER_INTERVAL_SECONDS` as a quoted Wrangler `vars` value in the
local deployment configuration to change this window. For example,
`"STATUS_RENDER_INTERVAL_SECONDS": "120"` uses two minutes. Positive values
through 86,400 choose UTC-aligned windows in whole seconds. An explicit `"0"`
opts into immediate public rendering. An invalid binding falls back to 60
seconds and logs `invalid_status_render_interval`. Operator authorization,
Checks, and alert delivery run independently of public rendering.

HTTP/TCP targets must be reachable from Cloudflare;
TCP is plain connection establishment, not TLS/protocol verification. Cloudflare
[socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
still apply (including prohibited ports/addresses).
POST `/heartbeat/<id>` with `Authorization: Bearer <installation secret>` from a
producer. Bodies are ignored. Never place the secret in a query string.

Webhook delivery uses the separate Worker and the per-install Queue configured
above. Keep automatic traces disabled on that Worker because
[fetch spans can include credential-bearing URLs](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/#fetch).
Workers Logs still capture sanitized submission failures. `npm run build:delivery`
dry-runs the bundle and `npm run test:delivery` exercises both Workers locally.

In Operator Settings, choose Add webhook under Notification destinations. Then
edit each Monitor that should send Incident notifications, check the desired
destinations, and save the Monitor. Upgraded webhooks retain their address and
start unselected on every Monitor. Removing a webhook or replacing its address
clears its selections. Slack-compatible messages include the Monitor
name, the transition and its original UTC time. The monitoring and delivery Workers can run with webhook bindings alone.
Declare, replace or end per-Monitor Maintenance in its ledger. Checks continue,
Incident detection and Incident alerts are suppressed, and Incidents are retained.
Selected webhooks and confirmed inboxes receive Maintenance notices. History shows 90 UTC calendar days;
Maintenance is excluded from availability. Delete stops checking but retains
operator Incidents. See the [Monitor API](monitor-api.md) for timing and
scheduling behavior and the [Heartbeat API](heartbeat-api.md) for receipt
and recovery rules.

The Operator session keeps the secret in browser memory until sign-out, reload,
or authorization loss. Both views support System, Light, and Dark themes. The
browser can save the theme preference locally. The views fetch a fresh snapshot
on connection and resync when you return to the tab. If the live connection is
lost, they poll once a minute while visible. Failed reads keep the last snapshot
and offer **Retry**. Live updates preserve Operator drafts and selected history
days. See the [subscription contract](hosted-contract.md#public-subscriptions)
for the WebSocket and partial response protocol.

Cron runs each minute; [new trigger propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) can take up to 15 minutes.
Use [Wrangler's scheduled test route](development.md) for manual local checks.
Settings shows the latest submission result per destination. “Submission accepted”
means the provider accepted the request. Email can still fail during subsequent SMTP delivery.
Events include their original UTC time and can arrive out of order. An ambiguous provider response
or a crash before recording acceptance can produce duplicates. Temporary failures retry independently
with exponential delays, up to ten attempts and one hour from Queue acceptance.
Permanent failures stop immediately. Exhausted jobs go to the dead-letter Queue,
which has no automatic replay. Keep both Queues in the same jurisdiction.
If the Recovery object and the bookkeeping-only handoff to the source Queue
both reject writes on the final broker delivery, the broker can discard the job.
Settings can retain its previous result and the dead-letter Queue can receive
no diagnostic for that job.
Monitor Workers Logs for sanitized `notification_enqueue_failed`,
`notification_submission_failed`, `notification_submission_report_failed`,
`notification_dead_letter_failed`, `notification_recovery_unavailable`
and `notification_handoff_unavailable` events. The Incident or Maintenance
change remains committed if Queue handoff fails. Loss before Queue acceptance
is possible and there is no replay of those events.

For upgrades, retain the same Worker, `MONITORING` binding, class and migration
history, and deploy the reviewed new source. Back up operational configuration via
authenticated API in private storage. This is not a database/Incident backup or
restore tool. Code rollback does not roll back Durable Object data; review migration
compatibility before rollback. Never delete/recreate a production namespace to upgrade.

### Upgrade and roll back notification Workers

When upgrading from the context-wide webhook, retain the monitoring Worker and
its Durable Object namespace. The saved URL becomes an unselected destination.
Select it on each Monitor that should send future alerts. Earlier events are
never replayed. An older bundle with direct webhook delivery can broadcast
context-wide after rollback. Review the saved legacy URL and audience before
restoring such a version.

On an existing Queue installation, keep the Worker names, source Queue and
service binding. Configure the handoff producer on the existing source Queue,
the dead-letter Queue and the Recovery migration before upgrading the delivery
Worker. Keep source Queue delivery paused while changing versions:

1. Run `npx wrangler queues pause-delivery "$IRISBEAT_QUEUE_NAME"` and let any
   in-flight batches finish before deploying either Worker.
2. Deploy the monitoring Worker to make the trusted `resolveAlert` RPC available.
   Deploy the compatible delivery Worker and verify the active revisions and
   bindings. The new consumer can handle Incident jobs from the previous producer.
3. Run `npx wrangler queues resume-delivery "$IRISBEAT_QUEUE_NAME"` once both
   compatible revisions are active.

Monitoring can keep enqueueing during the pause, including new Maintenance jobs.
Queued jobs remain subject to Cloudflare message retention and Irisbeat's one-hour
submission limit. Existing Monitor selections stay in place.
[Cloudflare Queue delivery controls](https://developers.cloudflare.com/queues/configuration/pause-purge/)

For rollback, use a compatible Worker pair that supports the stored data and
the jobs still in the source Queue, including delayed retries. Its delivery
Worker must also support any pending Recovery reports, diagnostics and
bookkeeping handoffs. Use the same pause, in-flight drain, deploy, verify and
resume sequence. If a previous pair lacks that compatibility, keep the compatible
pair in place and deploy a forward fix. [Cloudflare rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

When upgrading from the confirmation-only build, existing inboxes retain consent and
Monitor selections. The engine provisions withdrawal credentials from
`NOTIFICATION_PUBLIC_ORIGIN` for self-hosted alerts and from the trusted
[context origin](hosted-contract.md#trusted-adapter) for hosted alerts.

## Availability history

The monitoring Worker needs an Analytics Engine dataset and a server-side SQL
credential. Create a custom API token with **Account → Account Analytics →
Read**, scoped to the account that runs this Worker. Store it as the
`AVAILABILITY_API_TOKEN` Worker secret. Set `AVAILABILITY_ACCOUNT_ID` to the
same account ID as a Worker variable. The default dataset is
`irisbeat_availability`, declared as the `AVAILABILITY_HISTORY` write binding
in `wrangler.jsonc`. The dataset is created on the first write. If the Deploy
button leaves out the binding, add an Analytics Engine binding under the
monitoring Worker's **Settings → Bindings** with that exact binding and dataset.
If you use a different dataset, set `AVAILABILITY_DATASET` to match the binding's
dataset name and retain that name in the installation's Wrangler configuration.
Use letters, digits and underscores for the dataset name, starting with a letter
or underscore.

For routine deploys, keep `keep_vars` enabled to retain dashboard variables
such as `AVAILABILITY_ACCOUNT_ID` and `AVAILABILITY_DATASET`. Leave the stored
Worker secret in place and keep the write binding in the configuration used
for each deploy. Confirm the deployed bindings and readiness afterward.
For a deployed Worker, `npx wrangler secret put
AVAILABILITY_API_TOKEN --name "$IRISBEAT_WORKER_NAME"` prompts privately for a
replacement token. Managed deployments can supply the
[trusted query service](hosted-contract.md#availability-history) instead.

Create an active Monitor and let it record an observation. Verify
`GET /api/operator/history/readiness` with the installation Bearer secret.
HTTP 200 with `{ "ready": true }` confirms the query can read the Monitor's
actual observation from the write dataset. HTTP 503 returns a reason:

| Reason | Meaning |
| --- | --- |
| `configuration_missing` | Write binding or SQL configuration is missing or invalid. |
| `observation_pending` | Wait for an eligible Monitor observation since cutover. |
| `observation_unconfirmed` | The query did not find that observation. Allow for ingestion lag and check that the dataset matches. |
| `query_unavailable` | Check token scope, dataset and SQL service availability. The dataset can be unavailable before its first write is ingested. |

Open Status and Operator to verify the bars. The app continues serving current
Monitor status and Incidents and delivering alerts if a history query fails.
The history bars show a stale message if a cached series survives, or
“Bars unavailable” if it does not. Workers Logs expose sanitized
`history_write_failed` and `history_query_failed` events.

An upgrade from SQLite history discards the raw availability series after
both the write binding and a query path are configured.
Keep the existing Durable Object namespace so configuration, last results,
detection progress, Maintenance and Incidents survive. Bars fill from new
observations after the upgrade. The local cutover check is
`node test/upgrade.cjs --analytics`. Wrangler discards Analytics Engine writes
in ordinary local development. The local automated suite uses a test query
service or substitutes the SQL API. Verify the actual binding and token on the
installed Worker.

## Optional email confirmation

- In Cloudflare, onboard a sending domain and choose a sender address on that domain.
  Workers Paid is required for arbitrary recipients. Account-verified recipients can
  receive mail on the Free plan using a routing domain. Cloudflare verifies account
  destinations for transport eligibility. Irisbeat requires the recipient to confirm
  separately for each monitoring context.
  [Cloudflare pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and
  [send binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
- Before enabling email, turn off **Enable email preview** for the
  sending domain in Cloudflare under **Compute > Email Service > Email Sending >
  [sending domain] > Settings**. Keep it off while sending Irisbeat mail.
  Cloudflare turns it on for new sending domains and retains previews for about
  seven days. Previews include the HTML, plain text and raw message, which expose
  live confirmation and unsubscribe links. This prerequisite applies to self-hosted and hosted
  deployments. [Domain settings](https://developers.cloudflare.com/email-service/configuration/domains/#email-preview)
  and [Activity log message previews](https://developers.cloudflare.com/email-service/observability/logs/#message-preview).
- In your private delivery Worker configuration, add `send_email: [{ "name": "EMAIL" }]`
  and set the `EMAIL_FROM` variable to the sender address. Deploy the delivery Worker
  with the existing Queue consumer and `NOTIFICATION_DELIVERY` service binding.
- In your private monitoring Worker configuration, set `NOTIFICATION_PUBLIC_ORIGIN`
  to the installation's public HTTPS origin without a path. Add a service binding
  named `NOTIFICATION_EMAIL` pointing to the delivery Worker's
  `NotificationEmailCapability` entrypoint. The Workers can first be deployed with
  webhooks, then the monitoring Worker can be redeployed with the optional reverse binding.
- Open Operator Settings and choose **Add email**. The recipient opens the message
  and clicks **Confirm email** on the confirmation page. The inbox can then be
  selected on individual Monitors. Pending inboxes offer **Resend confirmation**.
  Resending replaces the previous link. The five-minute cooldown applies within
  the installation even if the inbox is removed and re-added.

Each Incident and Maintenance email includes an unsubscribe link. The recipient
opens the link and chooses **Unsubscribe**. This removes the inbox and its Monitor
selections from the context and cancels unsubmitted alerts. Cloudflare owns any
SMTP processing after acceptance.

Cloudflare still processes recipient metadata for transport. Keep addresses and
recipient links out of Irisbeat logs and Queue diagnostics. The delivery Worker
reports sanitized submission results in Settings and records exhausted jobs in the dead-letter Queue.

`npm run test:delivery` and the rendered Settings acceptance test read HTML, plain
text and synthetic sender and recipient metadata through the simulated
`send_email` binding. The tests use local capture without contacting Email Service.
[Cloudflare local simulation](https://developers.cloudflare.com/email-service/observability/local-development/sending/#local-simulation).

## Prepare and verify a release (no publication)

Commit all tracked changes first. From a Git checkout of that exact clean revision (release preparation requires
Git history; an extracted source archive alone supports installation, not repacking):

```sh
npm ci
npm run release:verify
```

The command runs Worker behavior tests, generated binding types and TypeScript,
both dry-run builds, archive reproducibility, a separately installed hosted
consumer and the exact-source personal deployment in local workerd. It exercises
both notification Workers from installed package exports and checks separation
using the Wrangler bundle metadata. External targets are substituted and email
is captured by the local Email Sending binding. `dist/` is ignored.

Run the browser workflows and upgrade checks from the same checkout.

```sh
npx playwright install chromium
npm run test:ui
node test/upgrade.cjs --notifications
node test/upgrade.cjs --analytics
node test/upgrade.cjs --live-views
npm run test:status:publication
npm run test:delivery:upgrade
```

These checks use local workerd, controlled time and synthetic recipients.

`npm run release:prepare` creates:

| Artifact | Use |
| --- | --- |
| `irisbeat-0.4.3-source.tar.gz` | Exact committed source, lockfile, config, tests, build/install instructions, LICENSE and NOTICE |
| `irisbeat-0.4.3.tgz` | TypeScript exports for both Workers, configuration references, integration docs, LICENSE and NOTICE |
| `release.json` | Full Git revision, version, contract 1, SHA-256 hashes and engine npm SHA-512 integrity |
| `SHA256SUMS` | SHA-256 integrity for both archives and the manifest |

No compiled dependencies are redistributed. Install dependencies using the lockfile;
the supported Node version and that lockfile are required for repeatable builds.
The same committed revision produces byte-identical archives. SHA-256 detects
changed bytes; obtain the manifest/checksums from a trusted reviewed release.
Untracked files and ignored local secrets are never added to the source archive.
Git archive includes test fixtures in Corresponding Source; npm's explicit files
allowlist excludes them from the engine package. `private: true` intentionally
prevents accidental registry publication; consumers install the versioned tarball.
See [hosted contract 1](hosted-contract.md) for exact version/integrity pinning,
trusted identity, permissions, allowance, notification Queue and policyRevision requirements.

## Candidate runtime acceptance

Use only a new disposable Worker in the selected account, the exact reviewed
source archive above, and one task-specific controlled target service. Before
any upload, record the revision and hashes, verify Worker-name absence, confirm
account selection and prepare the secret file as described above. Do not log credentials,
full target/webhook URLs or bearer values in public evidence.

The controlled service needs an HTTPS health path switchable between 204 and 503,
a plain TCP listener switchable between accept/refuse, and an HTTPS webhook sink
that records only received JSON. Provision these separately; this
public repository supplies no infrastructure. Restrict test use to those
explicit destinations, bounded to this drill. Never point at real Slack/Discord
channels or arbitrary public sites. Use default one-minute intervals, thresholds
2/2, and a Heartbeat with 180-second silence, 60-second recovery spacing and recovery count 2.

1. Install the candidate artifacts through the exact-source CLI path.
   Confirm the monitoring workers.dev URL and cron, and the delivery Worker’s
   Queue trigger and named service binding.
2. Verify anonymous operator API writes and wrong-secret heartbeat POSTs return 401;
   correct Bearer configuration works. Name the page, add all three kinds, and prove
   anonymous HTML/JSON omit targets, destinations and credentials. Confirm the named
   anonymous ledger. Record that the versioned Source download is pending release
   publication; verify its availability in the post-publication gate below.
3. In Settings, add the controlled webhook. Edit each drill Monitor, select the
   webhook, and save.
   With HTTP 204/TCP accepting and spaced receipts, wait for scheduled observations.
   Switch HTTP to 503/TCP to refuse, withhold Heartbeats past silence; observe one
   Incident and one opening webhook per Monitor after the required observations.
   Extra failures must not duplicate alerts. Record UTC timestamps and sink JSON.
4. Declare Maintenance over open outages. Switch targets healthy and send receipts:
   windows remain visible, no alert/recovery, and bars exclude these observations.
   Replace then end windows. Two later healthy observations/spaced receipts recover
   the same Incidents and send one recovery webhook each. Confirm 90 bars, percentage,
   empty days and retained Incidents. Unpublish a row and confirm it still checks.
5. Delete a Monitor: its public row/Incidents disappear, operator Incidents remain.
   Redeploy the same reviewed artifact and prove remaining configuration/history
   persists. Local suites cover exact timing/UTC boundaries; live evidence covers
   actual Cloudflare socket/cron/secret/resource behavior.
6. Stop producers, remove the drill webhook in Settings, and delete only drill Monitors.
   Verify both disposable Worker names, both Queues and the account. Detach the
   delivery Worker using `npx wrangler queues consumer remove "$IRISBEAT_QUEUE_NAME" "$IRISBEAT_DELIVERY_WORKER_NAME"`.
   Delete the delivery Worker, then the monitoring Worker using
   `npx wrangler delete <worker-name>`. Delete both disposable Queues with
   `npx wrangler queues delete <queue-name>`. Worker deletion destroys its
   associated DO data. Confirm removal, then remove any separate controlled
   target service, cloned test build/repository connection and private local
   credential files. Retain only sanitized evidence and artifact hashes.

Bound the live drill to 30 minutes after cron activation (allow up to 15 minutes
for new cron propagation). If targets/cron fail to initialize, stop and investigate;
do not widen destinations or call dry-run/local evidence a live pass.

## Verify the transition to Analytics Engine

Use a disposable pre-Analytics installation (for example, Irisbeat 0.3.0)
and a separate fresh installation. Record the candidate revision, artifact
hashes, Worker version IDs, and UTC timestamps. Give each install its own
Analytics Engine dataset.

1. Before upgrading, capture public and Operator snapshots. Include a published
   Monitor with an open Incident and partial recovery, a private Monitor in
   Maintenance, and a selected webhook.
2. Upgrade the existing installation using the reviewed artifact. Retain the
   monitoring Worker, Durable Object namespace, and notification queues. Set
   the [Analytics Engine bindings](#availability-history) before dispatch.
3. Verify that Monitor IDs, configuration, publication, current results,
   Maintenance, Incidents, and alert selections survive. The 90-day history
   starts empty. Readiness reports `observation_pending` until a new observation
   can be read from Analytics Engine.
4. Record a successful observation and verify readiness, both history views,
   and continued alert delivery. Fetch an affected Status partial after its
   publication window to verify that public history catches up.
5. Repeat setup on a fresh Worker and redeploy it without re-entering the
   secrets. Check that the bindings, readiness, and history survive. Clean up
   both disposable installations using the [runtime acceptance checklist](#candidate-runtime-acceptance).

## Publication gate and Corresponding Source

Release maintainers first review the PR and full implementation, complete local
release verification and the candidate runtime acceptance above, then merge the
reviewed source to main.
Choose a version that has no tag or release in the repository. Before preparing
the release, set that version in `package.json`, `package-lock.json`,
`NOTICE`, the tarball dependency in `test/consumer/package.json`, and the
Status and Operator Source links in `src/ui.tsx`. Update the current-release
examples in this guide and the hosted contract. Regenerate the versioned
artifacts from the **final** clean release revision and repeat
`npm run release:verify` on that revision.

Once authorized, tag that exact revision with the unused version, create a draft
GitHub release, and attach all four regenerated artifacts. Verify the downloaded
hashes before publishing. Set `IRISBEAT_RELEASE_NOTES` to the reviewed notes
file and run the following after pushing the tag.

```sh
IRISBEAT_RELEASE_VERSION="$(node -p 'require("./package.json").version')"
gh release create "v$IRISBEAT_RELEASE_VERSION" --verify-tag --draft \
  --title "Irisbeat $IRISBEAT_RELEASE_VERSION" --notes-file "$IRISBEAT_RELEASE_NOTES" \
  "dist/irisbeat-$IRISBEAT_RELEASE_VERSION.tgz" \
  "dist/irisbeat-$IRISBEAT_RELEASE_VERSION-source.tar.gz" \
  dist/release.json dist/SHA256SUMS --repo Webriot/irisbeat
```

Follow [GitHub release guidance](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
Publish changes under a new version and preserve existing release artifacts.
The public and Operator Source links target that release's source archive.
Irisbeat's own code is AGPL-3.0-only, with LICENSE and NOTICE in both archives. Provide Corresponding Source to network users of your
running version. If modified, publish its complete corresponding source/build
instructions and update `src/ui.tsx`'s Source link before serving it; the upstream
release link is insufficient for modifications. Preserve third-party notices.

## Post-publication acceptance

After the reviewed code is on main and the tag, release and artifacts are public:

1. Download all four release artifacts, verify their checksums and manifest revision,
   and confirm the public/operator Source link downloads the matching source archive.
2. Use the Deploy to Cloudflare button to install into another unused Worker. Record
   the installed revision and verify the secret prompt and build/deploy configuration.
   Give that installation its own Queues and deploy its delivery Worker using the
   exact-source binding steps above, then run runtime acceptance.
3. Remove the disposable installation and controlled targets using the cleanup step
   above. Record sanitized evidence for both the candidate CLI and published button
   installations.

If a check fails, correct the deployment instructions or publish a new version.
Preserve the artifacts for existing releases.
