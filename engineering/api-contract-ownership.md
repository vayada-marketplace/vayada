# API contract ownership

_VAY-850 post-rewrite decision record. Complements
[`typescript-backend-structure.md`](typescript-backend-structure.md),
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
and [`request-context-contract.md`](request-context-contract.md)._

## Decision

Do not create a global DTO package. Contract ownership follows the runtime
boundary that owns the behavior:

| Contract kind                                                             | Owner                                     | Location                           |
| ------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| Domain commands, read models, ports, events, and domain contract versions | Product domain                            | `packages/domain-*`                |
| Route-specific HTTP request, response, and error shapes                   | Owning API route adapter                  | `apps/api/src/routes/...`          |
| Shared HTTP primitives                                                    | Backend HTTP package                      | `packages/backend-http`            |
| Frontend API client input/output types                                    | Consuming frontend surface                | `apps/*/services/api/*Client.ts`   |
| Compatibility adapters and legacy shapes                                  | Adapter owner named in the route contract | Route doc plus owning adapter/test |

`packages/backend-http` is the canonical source for shared HTTP primitives:
error envelopes, pagination envelopes, idempotency metadata, HTTP method names,
and route-contract helper types. It must stay product-neutral. Product fields,
status enums, and business errors belong in the owning domain or route.

## Rules

1. Domain packages own business language, not HTTP transport. A domain package
   may export commands, read models, ports, events, money/date aliases, and
   contract versions.
2. Route adapters own transport-specific shapes when the shape exists only for
   that route. The adapter translates HTTP input into domain calls and returns
   the route contract.
3. Frontends consume one typed client per surface. Components should call the
   client, not normalize raw `fetch` payloads inline or import internal domain
   commands.
4. Compatibility shapes need an owner and a removal condition. If a legacy
   response key remains for UI stability, document when it can be removed.
5. Shared primitives can move to `packages/backend-http`; product-specific DTOs
   cannot. A new `packages/dtos` or `packages/shared-dtos` bucket is forbidden.

## Representative Surface

The Booking Admin reservations list is the accepted example:

| Layer                 | Artifact                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decision/contract doc | [`booking-reservation-list-contract.md`](booking-reservation-list-contract.md)                                                                                                 |
| Domain/read boundary  | `BookingReservationReadModel` and `BookingReservationsReadRepository` in [`packages/domain-booking`](../packages/domain-booking/src/index.ts)                                  |
| HTTP route contract   | `BOOKING_RESERVATION_LIST_CONTRACT` and exported request/response/error types in [`apps/api/src/routes/bookingReservations.ts`](../apps/api/src/routes/bookingReservations.ts) |
| Frontend typed client | [`apps/booking-admin/services/api/bookingReservationsClient.ts`](../apps/booking-admin/services/api/bookingReservationsClient.ts)                                              |
| Screen consumer       | [`apps/booking-admin/app/(app)/reservations/page.tsx`](<../apps/booking-admin/app/(app)/reservations/page.tsx>)                                                                |
| Tests                 | `apps/api/src/app.test.ts` and `tests/e2e/booking-admin/reservations.spec.ts`                                                                                                  |

This surface keeps the route-specific `bookings` response key because Booking
Admin still consumes it. The removal condition is a future surface-specific
ticket that changes the frontend contract and route response together.

## Remaining Compatibility Shapes

| Shape                                                                        | Owner                                        | Removal condition                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Booking Admin reservation list `bookings` response and legacy field defaults | Booking route adapter / Booking Admin client | Booking Admin accepts a renamed reservations response and typed empty/null states.                                      |
| Auth compatibility tokens for legacy surfaces                                | Auth/session route adapter                   | Each frontend uses AuthKit/RequestContext directly and no FastAPI bridge needs scoped tokens.                           |
| Booking Web public compatibility routes under `/api/booking-web/...`         | Booking Web public adapter                   | Guest booking, affiliate, payment settings, and lookup commands use target Booking/Finance/Marketplace routes directly. |
| PMS compatibility aliases for old admin operations                           | PMS operations route adapter                 | PMS Web uses only `/api/pms/properties/:propertyId/...` typed clients and accepted smokes cover the screens.            |
| Legacy product database read-model adapters                                  | Owning route adapter                         | Target read model exists, parity passes, and runtime config no longer needs legacy product DB URLs.                     |

## Boundary Enforcement

`scripts/check-architecture-boundaries.mjs` is the lightweight guardrail. It
blocks known cross-domain database/import violations and now fails if a global
DTO package bucket is introduced. Add narrow checks there when a repeated
boundary mistake appears; do not build a broad framework before there is a
real violation to prevent.
