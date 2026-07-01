# TypeScript Backend Parity: Old-Route Urgent Fixes

On 2026-06-24, these urgent customer tickets were implemented and deployed on the old Python-backed route stack via `codex/prod-rollback-2026-06-04`.

Before cutting production traffic to the new TypeScript backend, port the equivalent behavior into the TypeScript backend/target contracts. Do not treat the old FastAPI database boundaries as the target design; preserve the product behavior.

| Tickets                   | Old PR     | Parity needed in the TypeScript backend rewrite                                                                                                                                                                                                       |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAY-632, VAY-633, VAY-634 | vayada#405 | Booking payment disclosure flow: no pre-submit bank details, T&C/cancellation acceptance validation, payment-method-specific confirmation notes, and bank-transfer details only after booking acceptance/instant confirmation.                        |
| VAY-623, VAY-638          | vayada#406 | Room detail behavior stays compatible with booking APIs: modal CTA navigation must survive route changes, and room detail map data must support zoom/pan/pinch UI without losing checkout selection. Mostly frontend, but API payload parity matters. |
| VAY-316                   | vayada#407 | Last-minute discount settings must round-trip correctly, including the hotel-level `enabled` master switch and camelCase/snake_case compatibility expected by Booking Admin and PMS.                                                                  |
| VAY-492                   | vayada#408 | Multi-room quantity booking: search results expose remaining inventory/capacity, checkout carries `rooms`, pricing multiplies by room quantity, and backend validation/inventory consumption handles multi-room bookings.                             |
| VAY-646                   | vayada#410 | Covered by VAY-977: guest phone required/optional setting exists across admin settings, public checkout settings, and booking submission validation. Optional phone allows direct bookings with an empty phone value.                                 |
| VAY-622                   | vayada#411 | PMS room location editing must support address geocoding, saved `locationAddress`/latitude/longitude, coordinate-only remote locations, and duplicate-room preservation of location fields.                                                           |
| VAY-657                   | vayada#412 | PMS Inbox hub foundation: message templates, variable rendering, guest automation rules, idempotent scheduled sends, Channex OTA delivery, direct/email fallback threads, and automation-visible outbound messages.                                   |

Deployment note: `booking.vayada.com` root routing was fixed in `vayada-platform#27`; keep the legacy root host and `*.booking.vayada.com` host behavior during cutover planning.
