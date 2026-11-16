# Live change notifications with authorized snapshot reads

The public Status page and operator UI use scoped WebSocket change notifications
followed by existing authorized JSON reads, updating changed UI elements without
document reloads. Snapshot reads preserve request-time authorization and the
public/operator projections at the cost of an extra read. Writes remain on HTTP;
automatic reconnect resynchronizes immediately, with 60-second visible-page JSON
polling as fallback while disconnected.

Accepted in the [approved design revision](https://github.com/Webriot/irisbeat/tree/1b26da8626e82fad17ff8c046952184515bfc8f5).
Public subscriptions are implemented by #30. Operator subscription authorization
remains #31; HTTP authorization alone does not authorize a socket subscription.
The public channel compares committed public facts at one fixed instant per
synchronous mutation stage, including its state read and expiry processing. An
outbound check captures a new instant when its result returns. History equality
uses committed observation counts; a failed or recovered presentation query is
not a committed change. Snapshot reads still expose unavailable history as null
and log query failures. Storage failures in the committed comparison propagate
rather than becoming an empty series or a notification. The channel carries
neither shared revisions nor private change activity. Public clock changes
(Maintenance expiry and UTC history rollover) use an independent Durable Object
alarm; mutation scheduling preserves an overdue clock deadline until that path
processes it. Per-socket pending/dirty attachments bound notification work across
hibernation; existing HTTP reads remain authoritative after disconnect/recreation.
