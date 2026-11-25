# Notification destination API

Send `Authorization: Bearer <credential>` with a Write API key or the installation secret. See [automation API authentication](api-v1.md) for authorization errors. These routes are available on self-hosted Workers.

## Destination response

Create, read, and edit return a single JSON object with the saved destination.

```json
{
  "id": "930aab51-f160-4dc0-a7be-13058f093602",
  "name": "Operations webhook",
  "channel": "webhook",
  "url": "https://hooks.example/alerts"
}
```

```json
{
  "id": "230a5bf8-e9a7-4406-80cb-11bc48a7d6d1",
  "name": "Operations inbox",
  "channel": "email",
  "address": "Ops@example.com",
  "confirmed": false
}
```

`id` is an opaque string. `url` and `address` are the exact stored values. Treat webhook URLs as sensitive since they may contain credentials. Email destinations report `confirmed: false` until the recipient confirms the address. Confirmation tokens, delivery information, and Monitor assignments are excluded from the resource.

## Create a destination

`POST /api/v1/destinations` returns `201`.

Send an `application/json` object in one of these forms.

| Channel | Request fields |
| --- | --- |
| Webhook | `{channel?: "webhook", url, name?}` |
| Email | `{channel: "email", address, name?}` |

A name is trimmed and must contain 1–120 characters on one line. Irisbeat generates a name such as `Webhook 1` or `Email 1` when it is omitted. Webhook input must be an HTTPS URL of at most 2,048 characters without whitespace, embedded credentials, or a fragment. Irisbeat stores recognized Discord webhook URLs with the `/slack` suffix. Email input must be a single mailbox. Irisbeat trims surrounding whitespace and lowercases the domain.

New email destinations start pending and require [email delivery and recipient confirmation](install.md#optional-email-confirmation). Irisbeat schedules the confirmation email when the installation is active. A paused installation can save the pending destination. To resend confirmation, use Operator Settings. Pending destinations cannot be assigned to Monitors.

## Read a destination

`GET /api/v1/destinations/:id` returns `200`. Use the saved values to import the resource or compare it with a desired configuration.

## Edit a destination

`PATCH /api/v1/destinations/:id` returns `200`. Send an `application/json` object in one of these forms.

| Change | Request fields |
| --- | --- |
| Rename | `{name}` |
| Set a webhook URL | `{channel?: "webhook", url, name?}` |
| Set an email address | `{channel: "email", address, name?}` |

The same name and address validation applies as on create. Omitting `name` preserves the saved name. Renaming or resubmitting an address that resolves to the same saved value preserves the ID and Monitor assignments. Changing the saved address or channel returns a replacement with a new ID and clears the previous ID's Monitor assignments. The previous ID returns `404` after replacement. A replacement email destination requires fresh recipient confirmation.

Create and edit use the documented request fields. Extra fields are ignored. In particular, sending `id` or `confirmed` does not set those values.

## Delete a destination

`DELETE /api/v1/destinations/:id` returns `204` with an empty body and clears the destination's Monitor assignments.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON or destination input |
| `404` | Unknown destination ID |
| `405` | Method unavailable at this path. The `Allow` header lists supported methods. |
| `409` | Case-insensitive name or email inbox already in use |
| `413` | Request body exceeds 16 KiB |
| `415` | Request body requires `application/json` |
| `429` | A confirmation for this inbox was issued within the last five minutes |
| `503` | Email sending is unavailable |

Destination errors with a JSON body use `{"error":"<message>"}`. The `405` and `413` responses have empty bodies.
