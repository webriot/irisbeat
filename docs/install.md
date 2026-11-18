# Personal installation and release operations

Implements [#12](https://github.com/webriot/irisbeat/issues/12) under
[spec #1](https://github.com/webriot/irisbeat/issues/1). The owner decisions live
there. This candidate is unpublished; live installation and publication acceptance
remain pending. No Cloudflare account, host, credential or infrastructure is bundled.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/webriot/irisbeat)

The button uses the public repository's default branch. Until the reviewed
integration reaches main, use the exact-source CLI path below for this candidate;
the button cannot install unreleased integration changes from main. Do not claim
button acceptance until the release code is on main and a real install passes.

Sign into your own Cloudflare and GitHub/GitLab accounts. Choose a new repository
and an unused Worker name. Set a unique random `INSTALLATION_SECRET` in the secret
prompt (`openssl rand -hex 32` generates one locally). Keep it in a password manager.
The empty `.dev.vars.example` declares the prompt; never accept an empty value.
Keep the default build command `npm run build` (local bundle validation) and deploy
command `npm run deploy` (actual upload). The Wrangler configuration supplies the
SQLite `MonitoringContext` binding/migration, one-minute cron and workers.dev URL.
No external database, identity service, custom hostname, email or billing integration
is required. Cloudflare account limits and charges apply, including DO usage.

This follows Cloudflare's documented [Deploy button configuration](https://developers.cloudflare.com/workers/platform/deploy-buttons/),
including `cloudflare.bindings` descriptions and secret example files. Account
permissions, repository authorization and the actual build form still require a
real install drill. The button deploys the monitoring Worker only. For a complete
webhook installation, use the per-install Queue and delivery Worker setup below.
Do not put a credential in Wrangler vars or a repository.

## Exact-source CLI installation

Requires Node >=22.12, npm, a Cloudflare account and its workers.dev subdomain.
Download `irisbeat-0.2.2-source.tar.gz`, `release.json` and `SHA256SUMS` from the
reviewed release, verifying that the manifest's full revision is the intended one.
For an unpublished candidate, use the artifacts produced by `release:prepare`
from its reviewed Git revision instead of a release download.
Download the engine tarball too if checking the entire checksum file.

```sh
sha256sum --check SHA256SUMS
tar -xzf irisbeat-0.2.2-source.tar.gz
cd irisbeat-0.2.2
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
recordings, source control and shell command arguments. For a fresh installation,
deploy the monitoring Worker and secret together. After that succeeds, deploy the consumer so its
service binding can resolve the monitoring Worker.

```sh
npm run deploy -- --name "$IRISBEAT_WORKER_NAME" --secrets-file "$IRISBEAT_SECRET_FILE" &&
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
show published rows only. HTTP/TCP targets must be reachable from Cloudflare;
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
name, the transition and its original UTC time. Webhook-only installations need
no email configuration.
Declare, replace or end per-Monitor Maintenance in its ledger. Checks continue,
Incident detection and alerts are suppressed, and Incidents are retained. Selected
webhooks receive Maintenance notices. History shows 90 UTC calendar days;
Maintenance is excluded from availability. Delete stops checking but retains
operator Incidents. Detailed bounds and semantics are in README and the API handoffs.

Cron runs each minute; [new trigger propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) can take up to 15 minutes.
Do not expect a live `/__scheduled` endpoint: it is a Wrangler-local test route.
Settings shows the latest submission result per destination. “Submission accepted”
means the provider accepted the request. Temporary failures retry independently
with exponential delays, up to ten attempts and one hour from Queue acceptance.
Permanent failures stop immediately. Exhausted jobs go to the dead-letter Queue,
which has no automatic replay. Keep both Queues in the same jurisdiction.
Monitor Workers Logs for sanitized `notification_enqueue_failed`,
`notification_submission_failed`, `notification_submission_report_failed`,
`notification_dead_letter_failed`, `notification_recovery_unavailable`
and `notification_handoff_unavailable` events. The Incident or Maintenance
change remains committed if Queue handoff fails.

For upgrades, retain the same Worker, `MONITORING` binding, class and migration
history, and deploy the reviewed new source. Back up operational configuration via
authenticated API in private storage. This is not a database/Incident backup or
restore tool. Code rollback does not roll back Durable Object data; review migration
compatibility before rollback. Never delete/recreate a production namespace to upgrade.

### Upgrade and roll back notification Workers

On an existing Queue installation, keep the Worker names, source Queue and
service binding. Configure the handoff producer on the existing source Queue,
the dead-letter Queue and the Recovery migration before upgrading the delivery Worker. Deploy the delivery
Worker first, then deploy the monitoring Worker. The updated consumer handles
Incident jobs from the previous producer, so existing Monitor selections can
stay in place. Its Recovery object can retain Settings reports until the
upgraded monitoring Worker can accept them.

To roll back, restore the previous monitoring Worker first. Before restoring
a delivery Worker that cannot handle Maintenance events or bookkeeping messages,
drain queued and in-flight messages of those types and let pending result
and diagnostic writes settle. Keep the updated delivery Worker in place if
unsupported messages can still reach the source Queue.

## Optional email confirmation

- In Cloudflare, onboard a sending domain and choose a sender address on that domain.
  Workers Paid is required for arbitrary recipients. Account-verified recipients can
  receive mail on the Free plan using a routing domain. Cloudflare verifies account
  destinations for transport eligibility. Irisbeat requires the recipient to confirm
  separately for each monitoring context.
  [Cloudflare pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and
  [send binding restrictions](https://developers.cloudflare.com/email-service/configuration/send-bindings/).
- Before enabling confirmation mail, turn off **Enable email preview** for the
  sending domain in Cloudflare under **Compute > Email Service > Email Sending >
  [sending domain] > Settings**. Keep it off while sending confirmation mail.
  Cloudflare turns it on for new sending domains and retains previews for about
  seven days. Previews include the HTML, plain text and raw message, which expose
  the live confirmation link. This prerequisite applies to self-hosted and hosted
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

Cloudflare still processes recipient metadata for transport. Keep addresses and
confirmation links out of Irisbeat logs and Queue diagnostics. The delivery Worker
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

The command runs the complete behavior suite, separately installed hosted consumer
with integrity verification, generated binding types/TypeScript, dry-run build,
reproducibility checks and packaged personal deployment smoke in local workerd.
External HTTP/TCP/webhook targets are substituted; time is controlled. It makes
no Cloudflare deployment or third-party delivery. `dist/` is ignored.

`npm run release:prepare` creates:

| Artifact | Use |
| --- | --- |
| `irisbeat-0.2.2-source.tar.gz` | Exact committed source, lockfile, config, tests, build/install instructions, LICENSE and NOTICE |
| `irisbeat-0.2.2.tgz` | Source-only hosted engine package; no test adapter/fixtures or credentials |
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

## Candidate runtime acceptance (before publication, pending)

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
   Verify both disposable Worker names, both Queues and the account. Delete the
   delivery Worker first, then the monitoring Worker using
   `npx wrangler delete <worker-name>`. Delete both disposable Queues with
   `npx wrangler queues delete <queue-name>`. Worker deletion destroys its
   associated DO data. Confirm removal, then remove any separate controlled
   target service, cloned test build/repository connection and private local
   credential files. Retain only sanitized evidence and artifact hashes.

Bound the live drill to 30 minutes after cron activation (allow up to 15 minutes
for new cron propagation). If targets/cron fail to initialize, stop and investigate;
do not widen destinations or call dry-run/local evidence a live pass.

## Publication gate and Corresponding Source

Release maintainers first review the PR and full implementation, complete local
release verification and the candidate runtime acceptance above, then merge the
reviewed source to main. Keep #12 open and its publication acceptance incomplete.
Regenerate artifacts from the **final** clean release revision and
repeat `npm run release:verify`; integration candidate bytes do not represent a
later merge commit. Set version/source links together for future releases.

Only after authorization, create tag `v0.2.2` on that exact revision and a draft
GitHub release, attach all four artifacts, verify downloaded hashes, then publish.
For example, after creating and pushing the reviewed tag:

```sh
gh release create v0.2.2 --verify-tag --draft --title 'Irisbeat 0.2.2' --notes-file <reviewed-notes-file> dist/irisbeat-0.2.2.tgz dist/irisbeat-0.2.2-source.tar.gz dist/release.json dist/SHA256SUMS --repo Webriot/irisbeat
```

Follow [GitHub release guidance](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
Never replace published bytes for the same version; issue a new version instead.
The public/operator Source link targets that release's source archive. It remains
pending until publication. Irisbeat's own code is AGPL-3.0-only, with LICENSE and
NOTICE in both archives. Provide Corresponding Source to network users of your
running version. If modified, publish its complete corresponding source/build
instructions and update `src/ui.tsx`'s Source link before serving it; the upstream
release link is insufficient for modifications. Preserve third-party notices.

## Post-publication acceptance (pending)

After the reviewed code is on main and the tag, release and artifacts are public:

1. Download all four release artifacts, verify their checksums and manifest revision,
   and confirm the public/operator Source link downloads the matching source archive.
2. Use the Deploy to Cloudflare button to install into another unused Worker. Record
   the installed revision and verify the secret prompt and build/deploy configuration.
   Give that installation its own Queues and deploy its delivery Worker using the
   exact-source binding steps above, then run runtime acceptance.
3. Remove the disposable installation and controlled targets using the cleanup step
   above. Record sanitized evidence for both the candidate CLI and published button
   installations. Close #12 only after both gates and source-download verification pass.

A failed post-publication check leaves #12 open. Correct the deployment instructions
or publish a new version as needed; never replace an existing version's artifacts.
