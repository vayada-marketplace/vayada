# Lodgify integration (VAY-398)

Plan + discovery output for connecting the Vayada Booking Engine to
Lodgify-backed properties. Lodgify replaces both Vayada PMS and Channex
for hotels that opt into this integration — it is **not** an add-on
on top of the Vayada PMS stack.

This document captures the decisions and the deferred questions. It is
the contract subsequent VAY-\* tickets implement against.

## Phase split

| Phase           | Scope                                                                                                                                                                                                   | Ticket                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1a — foundation | Data model (`pms_type`, `lodgify_connections`), encrypted-secret helper, Lodgify API-client scaffold, connect/disconnect admin endpoints, Integrations tab UI. **No live sync, no booking write-back.** | **VAY-398 (this commit)** |
| 1b — read sync  | Rooms / rates / availability sync Lodgify → Vayada local cache. Render Lodgify-backed hotels in the guest-facing Booking Engine.                                                                        | follow-up                 |
| 2 — bookings    | Booking write-back to Lodgify on Stripe success; refund-on-availability-conflict flow.                                                                                                                  | follow-up                 |
| 3 — lifecycle   | Webhook ingest (or polling fallback) for modifications & cancellations made in Lodgify or via its channel manager.                                                                                      | follow-up                 |
| 4 — pilot       | Onboard 1–2 friendly properties; harden; GA.                                                                                                                                                            | follow-up                 |

## Authentication model

- **Per-property API key.** Each Lodgify property owner provides their
  own Lodgify API key. We do not act as an OAuth client — Lodgify's
  public API is API-key based (`X-ApiKey` header, scope: read + write
  on the connected property).
- **Stored encrypted at rest** in `lodgify_connections.api_key`, via
  `app/utils/integration_secrets.py` (Fernet, keyed off
  `INTEGRATION_SECRETS_KEY`).
- **Validated on save** by issuing `GET /v2/properties` against
  Lodgify — a 2xx response is the success signal; 401/403 surfaces as
  a "key invalid" error in the UI.

## Endpoints we will use

Confirmed from the public Lodgify v2 API docs
(<https://docs.lodgify.com/docs/getting-started-1>):

| Purpose                                 | Endpoint                             | Phase |
| --------------------------------------- | ------------------------------------ | ----- |
| Validate key, fetch property list       | `GET /v2/properties`                 | 1a    |
| Property details                        | `GET /v2/properties/{id}`            | 1b    |
| Room types                              | `GET /v2/properties/{id}/rooms`      | 1b    |
| Rate plans + daily rates                | `GET /v2/rates/calendar`             | 1b    |
| Availability calendar                   | `GET /v2/availability/{propertyId}`  | 1b    |
| Create reservation                      | `POST /v2/reservations`              | 2     |
| Reservation lookup (idempotency check)  | `GET /v2/reservations/{id}`          | 2     |
| Modifications / cancellations (polling) | `GET /v2/reservations?updatedSince=` | 3     |

**Webhook capability is unconfirmed.** Lodgify's public docs do not
clearly advertise outbound webhooks for reservation modifications.
Phase 3 will start by validating webhook availability with Lodgify
support and **fall back to polling** if webhooks are unavailable or
unreliable.

## Rate limits

- Per Lodgify support docs (to be reconfirmed at Phase 1b kickoff): a
  small per-key quota (think tens of req/min, not thousands).
- The `app/services/lodgify/client.py` wrapper:
  - Retries 5xx and timeouts with exponential backoff (3 attempts:
    0.5s, 1s, 2s).
  - On HTTP 429, sleeps for the value of the `Retry-After` header
    (or 5s if absent) and retries once.
  - Logs every non-2xx response with `hotel_id` so debugging a
    specific property is straightforward.

## Payment model — decision: Option A (Vayada captures)

The guest pays Vayada via Stripe (same flow as today). On Stripe
success we create the reservation in Lodgify marked as paid, with the
Stripe charge ID in a Lodgify booking note. Lodgify is **not** the
payment processor for Vayada-originated bookings.

Rationale:

- Keeps the booking-engine checkout UX identical regardless of
  back-end PMS — guests never see a Lodgify-branded payment step.
- Avoids the "Vayada showed confirmation but Lodgify's payment failed
  later" failure mode.
- Refund flow stays in Stripe, which we already operate.

Risk: if availability changes between guest selection and Stripe
capture, Lodgify will reject `POST /v2/reservations`. Phase 2 must
implement a refund-on-conflict step (refund the Stripe charge, surface
a clear error to the guest).

## Data model

### `booking_hotels.pms_type` (new)

Enum-typed text column with check constraint:

- `vayada_native` (default) — existing Vayada PMS + Channex hotels.
- `lodgify` — Vayada Booking Engine reads from Lodgify; bookings write
  to Lodgify.

A hotel cannot have both an active Lodgify connection and an active
Vayada-PMS hotel row. The UI enforces this; the backend re-checks at
connect time.

### `lodgify_connections` (new)

One row per Lodgify-backed hotel:

| Column                      | Type                                             | Notes                                           |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `id`                        | UUID PK                                          |                                                 |
| `hotel_id`                  | UUID FK → `booking_hotels(id) ON DELETE CASCADE` | unique                                          |
| `api_key_encrypted`         | TEXT                                             | Fernet ciphertext of the Lodgify API key        |
| `lodgify_property_id`       | TEXT                                             | The Lodgify property the hotel is bound to      |
| `lodgify_property_name`     | TEXT                                             | Cached display name (refreshed on validate)     |
| `status`                    | TEXT                                             | `active` / `disconnected` / `error`             |
| `last_validated_at`         | TIMESTAMPTZ                                      |                                                 |
| `last_error`                | TEXT                                             | Most recent failure message, surfaced in the UI |
| `created_at` / `updated_at` | TIMESTAMPTZ                                      |                                                 |

The `api_key_encrypted` column is **never** returned by the admin
status endpoint — the UI only ever sees a masked indicator
("connected" / "disconnected") and the Lodgify property name + id.

## Encrypted-secret storage

`app/utils/integration_secrets.py` exposes:

```python
encrypt(plaintext: str) -> str          # base64 Fernet token
decrypt(token: str) -> str
```

Keyed off the `INTEGRATION_SECRETS_KEY` env var (a urlsafe-base64
Fernet key, 32 bytes pre-encoding). Missing the env var is a startup
error in any environment that has a `lodgify_connections` row — but
the helper itself is lazy, so test envs that never encrypt anything
don't need a key configured.

Key rotation strategy is **deferred**: when we need it, we'll switch
to `MultiFernet` with the new key first in the list. Documented for
future-us; no code yet.

## Admin endpoints (Phase 1a)

All routes live under `/admin/integrations/lodgify` and require
`require_current_hotel`:

| Method | Path                                     | Body                               | Returns                   |
| ------ | ---------------------------------------- | ---------------------------------- | ------------------------- |
| POST   | `/admin/integrations/lodgify/connect`    | `{ api_key, lodgify_property_id }` | `LodgifyConnectionStatus` |
| DELETE | `/admin/integrations/lodgify/disconnect` | —                                  | `204`                     |
| GET    | `/admin/integrations/lodgify/status`     | —                                  | `LodgifyConnectionStatus` |

`LodgifyConnectionStatus`:

```json
{
  "connected": true,
  "lodgify_property_id": "12345",
  "lodgify_property_name": "Beach Villa",
  "last_validated_at": "2026-05-14T09:00:00Z",
  "last_error": null,
  "status": "active"
}
```

On `connect`, we:

1. Call `GET /v2/properties` with the supplied key. On 401/403 →
   422 with `"Invalid Lodgify API key"`.
2. Confirm the supplied `lodgify_property_id` is in the returned list.
3. Encrypt the key, upsert the row, flip `booking_hotels.pms_type` to
   `lodgify`.

On `disconnect`, we soft-delete: set `status='disconnected'`, clear
the encrypted key, leave `pms_type` set so we don't accidentally
overwrite a `vayada_native` hotel that was never on Lodgify.

## Deferred questions (open at end of Phase 1a)

1. **Webhook availability.** Confirm with Lodgify support whether
   outbound webhooks exist for reservation create / modify / cancel.
   Decide push vs poll in Phase 3 kickoff.
2. **Multi-room reservations.** Lodgify's `POST /v2/reservations`
   shape for guests booking two rooms in one transaction needs
   verification. If unsupported, the Booking Engine multi-room cart
   degrades to one Lodgify reservation per room (still one Stripe
   charge).
3. **Email sender.** Does Vayada or Lodgify send the guest
   confirmation email for Lodgify-backed bookings? Decision needed in
   Phase 2.
4. **Migration path for existing Vayada-native hotels switching to
   Lodgify.** Out of scope per the ticket; recorded here so we
   don't accidentally promise it.
5. **Existing reservations created in Lodgify before connection.**
   Phase 3 ingest scope — backfill on first connect, or forward-only?
   Default to forward-only unless a pilot property pushes back.

## Files added in Phase 1a

- `migrations/031_lodgify_integration.sql` — `pms_type` column +
  `lodgify_connections` table.
- `app/utils/integration_secrets.py` — Fernet wrapper.
- `app/services/lodgify/__init__.py`
- `app/services/lodgify/client.py` — async HTTP client.
- `app/services/lodgify/connection.py` — connect / disconnect /
  status service functions.
- `app/repositories/lodgify_connection_repo.py` — DB access.
- `app/models/lodgify.py` — request/response Pydantic models.
- `app/routers/admin/integrations/__init__.py` —
  `/admin/integrations` sub-router.
- `app/routers/admin/integrations/lodgify.py` — the three endpoints.
- `tests/test_integration_secrets.py` — encrypt/decrypt round-trip.
- `tests/test_lodgify_client.py` — retry / rate-limit behavior.
- `tests/test_admin_lodgify.py` — connect / disconnect endpoint
  happy + auth-failure paths.

Frontend admin (Phase 1a):

- `app/(app)/settings/page.tsx` — `'integrations'` tab added.
- `app/(app)/settings/integrations/lodgify/page.tsx` — connect /
  status / disconnect UI.
- `services/integrations/index.ts` — typed client for the three
  admin endpoints.
