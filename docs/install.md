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
real install drill. Do not put a credential in Wrangler vars or a repository.

## Exact-source CLI installation

Requires Node >=22.12, npm, a Cloudflare account and its workers.dev subdomain.
Download `irisbeat-0.1.0-source.tar.gz`, `release.json` and `SHA256SUMS` from the
reviewed release, verifying that the manifest's full revision is the intended one.
For an unpublished candidate, use the artifacts produced by `release:prepare`
from its reviewed Git revision instead of a release download.
Download the engine tarball too if checking the entire checksum file.

```sh
sha256sum --check SHA256SUMS
tar -xzf irisbeat-0.1.0-source.tar.gz
cd irisbeat-0.1.0
npm ci
npm run check
npm run build
npx wrangler login
npx wrangler whoami
```

Select the intended account using `CLOUDFLARE_ACCOUNT_ID` in the shell, outside
this repository, if more than one account is available. Set `IRISBEAT_WORKER_NAME` in the shell to an unused Worker name; keep the
reviewed `wrangler.jsonc`, bindings and migrations unchanged. Before a disposable
acceptance install, verify that your chosen Worker name is absent in that
account; never overwrite an existing Worker. Do not use a temporary claim account.

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
recordings, source control and shell command arguments. Deploy code and secret together:

```sh
npm run deploy -- --name "$IRISBEAT_WORKER_NAME" --secrets-file "$IRISBEAT_SECRET_FILE"
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

Save one HTTPS webhook destination in Operator alerts. It becomes live immediately;
there is no test-send or replay. Use only a destination controlled for this install.
The payload is `{ "text": "<Monitor>: Incident opened" }` or `Incident recovered`.
Declare/replace/end per-Monitor Maintenance in its ledger. Checks continue; detection
and alerts are suppressed, Incidents retained. History shows 90 UTC calendar days;
Maintenance is excluded from availability. Delete stops checking but retains
operator Incidents. Detailed bounds and semantics are in README and the API handoffs.

Cron runs each minute; [new trigger propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) can take up to 15 minutes.
Do not expect a live `/__scheduled` endpoint: it is a Wrangler-local test route.
Monitor Workers Logs for sanitized `webhook_delivery_failed` events and cron
errors; check actual public/operator responses. Alerts are best effort, without
retry or durable outbox. No deployment creates sample Monitors or sends messages.

For upgrades, retain the same Worker, `MONITORING` binding, class and migration
history, and deploy the reviewed new source. Back up operational configuration via
authenticated API in private storage. This is not a database/Incident backup or
restore tool. Code rollback does not roll back Durable Object data; review migration
compatibility before rollback. Never delete/recreate a production namespace to upgrade.

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
| `irisbeat-0.1.0-source.tar.gz` | Exact committed source, lockfile, config, tests, build/install instructions, LICENSE and NOTICE |
| `irisbeat-0.1.0.tgz` | Source-only hosted engine package; no test adapter/fixtures or credentials |
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
trusted identity, permissions, allowance, hook and policyRevision requirements.

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
   Confirm a workers.dev URL, binding and cron; no Accounts, Stripe, email or custom DNS.
2. Verify anonymous operator API writes and wrong-secret heartbeat POSTs return 401;
   correct Bearer configuration works. Name the page, add all three kinds, and prove
   anonymous HTML/JSON omit targets, destinations and credentials. Confirm the named
   anonymous ledger. Record that the versioned Source download is pending release
   publication; verify its availability in the post-publication gate below.
3. With HTTP 204/TCP accepting and spaced receipts, wait for scheduled observations.
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
6. Stop producers, remove webhook configuration, delete only drill Monitors, then
   remove only the disposable Worker using `npx wrangler delete <drill-name>`
   after verifying its name and account. Worker deletion destroys its associated DO data;
   never run against production. Confirm deletion, remove any separate controlled
   target service and cloned test build/repository connection, and remove private
   local credential files. Retain only sanitized evidence and artifact hashes.

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

Only after authorization, create tag `v0.1.0` on that exact revision and a draft
GitHub release, attach all four artifacts, verify downloaded hashes, then publish.
For example, after creating and pushing the reviewed tag:

```sh
gh release create v0.1.0 --verify-tag --draft --title 'Irisbeat 0.1.0' --notes-file <reviewed-notes-file> dist/irisbeat-0.1.0.tgz dist/irisbeat-0.1.0-source.tar.gz dist/release.json dist/SHA256SUMS --repo Webriot/irisbeat
```

Follow [GitHub release guidance](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).
Never replace published bytes for the same version; issue a new version instead.
The public/operator Source link targets that release's source archive. It remains
pending until publication. Irisbeat's own code is AGPL-3.0-only, with LICENSE and
NOTICE in both archives. Provide Corresponding Source to network users of your
running version. If modified, publish its complete corresponding source/build
instructions and update `src/ui.ts`'s Source link before serving it; the upstream
release link is insufficient for modifications. Preserve third-party notices.

## Post-publication acceptance (pending)

After the reviewed code is on main and the tag, release and artifacts are public:

1. Download all four release artifacts, verify their checksums and manifest revision,
   and confirm the public/operator Source link downloads the matching source archive.
2. Use the Deploy to Cloudflare button to install into another unused Worker. Record
   the installed revision, verify the secret prompt and build/deploy configuration,
   and run the runtime acceptance steps above against that installation.
3. Remove the disposable installation and controlled targets using the cleanup step
   above. Record sanitized evidence for both the candidate CLI and published button
   installations. Close #12 only after both gates and source-download verification pass.

A failed post-publication check leaves #12 open. Correct the deployment instructions
or publish a new version as needed; never replace an existing version's artifacts.
