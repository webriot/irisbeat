# Live change notifications with authorized snapshot reads

The public Status page and operator UI use scoped WebSocket change notifications
followed by existing authorized JSON reads, updating changed UI elements without
document reloads. Snapshot reads preserve request-time authorization and the
public/operator projections at the cost of an extra read. Writes remain on HTTP;
automatic reconnect resynchronizes immediately, with 60-second visible-page JSON
polling as fallback while disconnected.

Accepted in the [approved design revision](https://github.com/Webriot/irisbeat/tree/1b26da8626e82fad17ff8c046952184515bfc8f5).
Public subscriptions are implemented by #30. Operator subscriptions (#31) use an
HTTP-authorized, origin/context/audience-scoped single-use ticket (15 seconds) and
a socket lease ending 60 seconds after ticket issuance. This bounds permission
revocation without introducing hosted session infrastructure into the engine.
HTTP authorization alone does not authorize a socket subscription; renewal needs
a fresh authorized ticket. Snapshot reads retain request-time reader/editor
projections, and webhook-only changes notify editors only. Expiry checks guard
frames and acknowledgements as well as an independent persisted alarm deadline,
so clients cannot retain private change activity by avoiding snapshot reads.
The public channel compares committed public facts at one fixed instant per
synchronous mutation stage, including its state read and expiry processing. An
outbound check captures a new instant when its result returns. History equality
uses committed observation counts; a failed or recovered presentation query is
not a committed change. Snapshot reads still expose unavailable history as null
and log query failures. Storage failures in the committed comparison propagate
rather than becoming an empty series or a notification. The channel carries
neither shared revisions nor private change activity. Public clock changes
(Maintenance expiry and UTC history rollover) use an independent Durable Object
clock deadline; mutation scheduling preserves an overdue clock deadline until that path
processes it. Per-socket pending/dirty attachments bound notification work across
hibernation; existing HTTP reads remain authoritative after disconnect/recreation.

Public/operator clock deadlines and operator authorization expiry share the DO's
single alarm by scheduling the earliest independent deadline. Operator activity
must preserve overdue public clock work. Socket attachments retain only the
notification flags and lease deadline across hibernation. Long-lived credentials
remain on authenticated HTTP requests and in browser memory, never socket URLs,
protocols or persistent browser storage. See the [hosted integration contract](../hosted-contract.md#operator-subscriptions)
for renewal, revocation bounds and consumer handler forwarding.
