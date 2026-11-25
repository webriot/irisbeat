# Irisbeat automation API v1

| Method and path | Access | Reference |
| --- | --- | --- |
| `GET /api/v1/status` | Read or Write API key, or installation secret | [Monitor status](#monitor-status) |
| `POST /api/v1/monitors` | Write API key or installation secret | [Monitor configuration](monitor-api-v1.md) |
| `GET, PATCH, DELETE /api/v1/monitors/:id` | Write API key or installation secret | [Monitor configuration](monitor-api-v1.md) |
| `POST /api/v1/destinations` | Write API key or installation secret | [Create a destination](destination-api.md#create-a-destination) |
| `GET /api/v1/destinations/:id` | Write API key or installation secret | [Read a destination](destination-api.md#read-a-destination) |
| `PATCH /api/v1/destinations/:id` | Write API key or installation secret | [Edit a destination](destination-api.md#edit-a-destination) |
| `DELETE /api/v1/destinations/:id` | Write API key or installation secret | [Delete a destination](destination-api.md#delete-a-destination) |
| `GET /api/operator/api-keys` | Installation secret | [List keys](#list-keys) |
| `POST /api/operator/api-keys` | Installation secret | [Issue a key](#issue-a-key) |
| `DELETE /api/operator/api-keys/:id` | Installation secret | [Revoke a key](#revoke-a-key) |

Send the credential in the `Authorization: Bearer <credential>` header. API keys are scoped to one self-hosted installation. A Read key grants status access. A Write key includes that access and is the role for versioned configuration routes. The installation secret grants access to every versioned operation plus key administration, Operator sign-in and actions, and personal Heartbeat receipts. Hosted Workers use their trusted adapter for existing operations and return `404` for these routes.

Versioned routes return `401` with `{"error":"Unauthorized"}` and a `WWW-Authenticate: Bearer` header for missing, invalid, expired, or revoked credentials. A valid Read key on a route requiring Write returns `403` with `{"error":"Forbidden"}`. Successful JSON responses use `application/json`. Responses use `Cache-Control: no-store`.

## Monitor status

`GET /api/v1/status` returns `200` with these fields.

| Field | Value |
| --- | --- |
| `pageName` | Status page name |
| `paused` | Boolean indicating whether this installation is paused |
| `monitors` | Status records for active published and private Monitors |
| `monitor` | The first record in `monitors`, or `null` |
| `incidents` | Incidents for active Monitors overlapping the 90-day UTC history window, newest first with ID as the tie-breaker |

Each Monitor record has `id`, `name`, `kind` (`http`, `tcp`, or `heartbeat`), `state` (`unknown`, `up`, `down`, `paused`, or `maintenance`), `lastResult`, `maintenance`, and `history`. Heartbeat Monitors additionally have `lastSeen` (Unix epoch milliseconds or `null`).

- `lastResult` is `{at, outcome}` or `null`. Outcomes are `success`, `failure`, and `maintenance`.
- `maintenance` is `{startedAt, endsAt}` or `null`.
- `history` is `{days, percentage, stale?, pending?}` or `null` when unavailable. A day has `{date, state, successes, failures, maintenance}`. The date is a UTC calendar date (`YYYY-MM-DD`), and the state is `up`, `down`, `degraded`, `maintenance`, or `empty`. The percentage is a number from 0 through 100 or `null` for zero eligible observations. Optional flags are `true` when present. See [Availability history](history-api.md).
- Each Incident is `{id, monitorId, monitorName, openedAt, closedAt}`. A missing retained name or recovery time is represented by `null`.

All instant timestamps are Unix epoch milliseconds. The status projection excludes saved targets, schedules, publication settings, notification destinations, and deleted-Monitor history. Anonymous `GET /api/status` continues to project published Monitors and their publicly visible Incidents.

## Key administration

### List keys

`GET /api/operator/api-keys` returns `200` with `{"keys":[...]}`, newest first with ID as the tie-breaker. Each record is `{id,name,role,createdAt,expiresAt}`. Expired keys remain listed until revoked. The server stores a digest of each secret and returns only metadata in the inventory.

### Issue a key

`POST /api/operator/api-keys` accepts `application/json` with `{name,role,expiresAt?}`. The name is trimmed and must have 1–120 characters. Roles are `read` and `write`. Omit `expiresAt` for a key without expiry, or pass a future Unix epoch millisecond timestamp as an integer. Invalid input returns `400`.

The `201` response has this shape.

```json
{
  "key": {
    "id": "930aab51-f160-4dc0-a7be-13058f093602",
    "name": "Status dashboard",
    "role": "read",
    "createdAt": 1795564800000,
    "expiresAt": null
  },
  "secret": "<bearer credential>"
}
```

Metadata timestamps are Unix epoch milliseconds. A `null` expiry denotes a key without expiry. Save `secret` when the key is issued. To rotate a credential, issue another key, switch the client to it, then revoke the old key. Names can be reused during rotation.

### Revoke a key

`DELETE /api/operator/api-keys/:id` returns `204` with an empty body, or `404` for an unknown ID. Revocation takes effect at the next authorization check. Already committed operations stand.

## Adding versioned configuration routes

In `createApp` in `src/index.ts`, register `app.use(path, versionedAuthorization("write"))` for each versioned configuration path before its method handlers. Apply the gate to configuration reads as well as mutations, before reading a request body or looking up an idempotency result. The gate accepts the installation secret and active Write keys, and leaves engine access available through `c.get("context")`. Keep the Operator and Heartbeat middleware on their existing routes.
