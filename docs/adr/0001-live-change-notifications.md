# Live change notifications with authorized snapshot reads

The public Status page and operator UI will use scoped WebSocket change
notifications followed by existing authorized JSON reads, updating only changed
UI elements without document reloads. This deliberately fetches snapshots rather
than streaming private field deltas: it preserves request-time authorization and
existing public/operator projections at the cost of an extra read per notification.
Writes remain on HTTP; automatic reconnect resynchronizes immediately, with
60-second visible-page JSON polling as fallback while disconnected.

This design is accepted but not yet implemented. Subscription authorization must
preserve context isolation and prevent public disclosure of private change
activity; HTTP authorization alone does not authorize a socket subscription.
