# Heartbeat integration

Implements [#6](https://github.com/webriot/irisbeat/issues/6) under [spec #1](https://github.com/webriot/irisbeat/issues/1). The Status ledger choice is recorded on [#2](https://github.com/webriot/irisbeat/issues/2#issuecomment-6865093219).

`PUT /api/operator` creates a Heartbeat with `kind: "heartbeat"`, page/Monitor names and optional timing. `intervalSeconds` is the expected producer cadence (default 60); `silenceSeconds` defaults to 180; `recoveryThreshold` defaults to two receipts; `recoverySpacingSeconds` defaults to 60. Seconds use integer bounds 60–86,400 and receipt count uses 1–100. Expectation describes producer cadence; the scheduled evaluation compares elapsed silence with `silenceSeconds`. These settings are independent. Omitted edits preserve values; kind is immutable. No hosted policy or configurable rule engine is introduced.

`POST /heartbeat/:id` requires `Authorization: Bearer <installation secret>`. A known Heartbeat returns 204. Wrong/missing authorization returns 401; authenticated unknown IDs and HTTP Monitors return 404. Authenticated unsupported methods return 405 with `Allow: POST`. Bodies, content type and content length are ignored; ingress never reads the body. Public responses expose kind and last-seen time, never a secret. Operator responses include timing.

Creation time anchors initial silence. Receipts update `lastSeen` independently of qualifying recovery observations. Scheduled silence evaluation opens an Incident at evaluation time, clears recovery progress and records failure; skipped cron dispatches invent no results. A first recovery receipt anchors spacing; duplicates and intermediate receipts refresh freshness without moving that anchor or advancing the count. Later qualifying receipts use current timing. Edits neither evaluate silence nor close an Incident. Existing Incident IDs and timestamps survive edits and object eviction.

## Sibling seams

Integration was merged through webhook #7 at `e0bfa2b`. Both HTTP attempts and heartbeat observations use the asynchronous `record` path, which commits detection before delivering an opening/recovery webhook. Repeated silence and duplicate receipts do not emit transitions. Preserve that per-Monitor transition seam when extending delivery.

Collection #4's [handoff](https://github.com/webriot/irisbeat/blob/t3/multiple-monitors-operator-controls/docs/monitor-api.md) is pending integration. This implementation retains the integration branch's single-Monitor API and `website` ID. On collection integration, carry `kind`, `createdAt`, `lastSeen`, `recoveryReceiptAt`, `silenceSeconds` and `recoverySpacingSeconds` into each Monitor; resolve ingress by ID, scope Incident queries by ID, and use creation-order `monitors[]`. Maintain HTTP timing, late-deletion guards, private-Monitor checks and webhook delivery. TCP #5 should share the outbound attempt/record path; a TCP target must never accept heartbeat ingress.

Hosted secret rotation, Maintenance and pause remain [#10](https://github.com/webriot/irisbeat/issues/10), [#8](https://github.com/webriot/irisbeat/issues/8) and [#11](https://github.com/webriot/irisbeat/issues/11). No deployment or browser automation was performed.
