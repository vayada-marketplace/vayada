# Frontend/backend contract migration

_Decision record for the TypeScript backend rewrite. This complements
`engineering/typescript-backend-structure.md`, `engineering/request-context-contract.md`,
and the target-schema contracts._

## Goal

Move frontend/backend integration to clean, typed product contracts while the
Python backends are replaced by the TypeScript backend.

The rewrite should not blindly preserve messy Python API payloads. Python route
shapes can be used as temporary compatibility bridges, but the target contract
should be explicit, stable, and owned by the product domain.

## Recommendation

Migrate one frontend surface at a time:

1. Pick a small product surface.
2. Define the request, response, error, authorization, and empty-state contract.
3. Implement the TypeScript route against the target domain model.
4. Add a typed frontend API client for that contract.
5. Update only the matching frontend screen or workflow.
6. Validate with contract tests, route tests, and a browser smoke.
7. Cut over that surface while Python continues serving everything else.

This keeps the frontend rewrite bounded while still improving the backend API
boundary instead of copying old backend quirks.

## Principles

- The frontend should depend on product API clients, not scattered raw `fetch`
  calls or Python-specific response quirks.
- TypeScript backend routes should expose target product contracts, not the old
  database layout or historical FastAPI router structure.
- Temporary compatibility adapters are allowed only to keep production behavior
  stable during cutover.
- A compatibility adapter should have an owner, a removal condition, and tests
  proving which legacy behavior it preserves.
- Contract changes should be made deliberately, screen by screen. Do not
  rewrite broad frontend areas without a matching backend contract.
- Python remains the production source of truth for non-migrated surfaces until
  the corresponding TypeScript route, frontend client, and smoke coverage are
  accepted.

## Contract Standard

Each new frontend/backend contract should define:

- Endpoint path and HTTP method.
- Request parameters and body shape.
- Response shape.
- Error codes and user-visible error categories.
- Pagination, sorting, and filtering rules where relevant.
- Date and timestamp format.
- Money format, currency source, and rounding behavior.
- Stable IDs and resource scope.
- Required permission, entitlement, and linked resource checks.
- Empty-state behavior.
- Loading and stale-data behavior if the surface depends on read models.
- Backward-compatibility notes for any intentionally preserved legacy behavior.

## Frontend Client Standard

Each migrated surface should add a typed frontend client function or module that
is the only place the screen talks to the backend contract.

For example:

```text
getBookingReservations(input) -> BookingReservationList
getBookingAddonSettings(input) -> BookingAddonSettings
updatePmsCalendarBlock(input) -> PmsCalendarBlock
```

React components should consume these typed client functions and render product
state. They should not normalize backend quirks inline.

## Backend Route Standard

TypeScript product routes should:

- Resolve authentication through `RequestContext` for protected surfaces.
- Use `enforceRoutePolicy` at the route boundary.
- Translate HTTP input into a domain command or read model request.
- Return the contract response shape directly.
- Keep SQL, third-party side effects, and product rules out of the route file
  unless the ticket is explicitly a temporary compatibility adapter.

## Validation

A migrated surface is not accepted until:

- The contract is documented or represented by exported TypeScript types.
- Backend route tests cover success, empty state, and authorization denial.
- Frontend code uses the typed client instead of raw endpoint handling.
- The affected frontend build passes.
- A browser smoke exercises the migrated screen.
- Any Python fallback or compatibility adapter is documented.

## First Vertical

The recommended first vertical is the booking reservations read surface because
it is useful, read-only, and already has early TypeScript route adapter work.

Contract artifact: [`BookingReservationList`](booking-reservation-list-contract.md).

Proposed slices:

1. Define `BookingReservationList` request/response/error contract.
2. Implement or tighten the TypeScript backend route.
3. Add the booking admin frontend API client.
4. Update the booking admin reservations screen to use the new client.
5. Run route tests, frontend build, and browser smoke.

Cutover and rollback for this surface are documented in
[`booking-reservations-cutover-runbook.md`](booking-reservations-cutover-runbook.md).

## Next Vertical

The next narrow booking-flow settings vertical is the add-on display settings
read surface.

Contract artifact: [`BookingAddonSettings`](booking-addon-settings-contract.md).

Proposed slices:

1. Define `BookingAddonSettings` request/response/error contract.
2. Add the booking admin frontend API client.
3. Implement or tighten the TypeScript backend route.
4. Update the Add-ons tab to consume the typed client when the route is ready.
5. Run route tests, frontend build, and browser smoke.

After this pattern is accepted, repeat for broader booking-flow settings, PMS
calendar, payments, marketplace collaborations, WorkOS auth/session, and Ask
Intelligence.

## Following Vertical

After `BookingAddonSettings` is closed end-to-end, the next narrow
booking-flow settings vertical is the guest-form settings read surface.

Contract artifact:
[`BookingGuestFormSettings`](booking-guest-form-settings-contract.md).

Proposed slices:

1. Define `BookingGuestFormSettings` request/response/error contract.
2. Add the booking admin frontend API client.
3. Implement or tighten the TypeScript backend route.
4. Update the Guest Form tab to consume the typed client when the route is
   ready.
5. Run route tests, frontend build, and browser smoke.

## Benefits Vertical

The next parallel booking-flow settings vertical is the Benefits tab read
surface.

Contract artifact:
[`BookingBenefitsSettings`](booking-benefits-settings-contract.md).

Proposed slices:

1. Define `BookingBenefitsSettings` request/response/error contract.
2. Add the booking admin frontend API client.
3. Implement or tighten the TypeScript backend route.
4. Update the Benefits tab to consume the typed client when the route is ready.
5. Run route tests, frontend build, and browser smoke.

## Localization Vertical

The next booking-flow settings vertical is the Localization tab read surface.

Contract artifact:
[`BookingLocalizationSettings`](booking-localization-settings-contract.md).

Proposed slices:

1. Define `BookingLocalizationSettings` request/response/error contract.
2. Add the booking admin frontend API client.
3. Implement or tighten the TypeScript backend route.
4. Update the Localization tab to consume the typed client when the route is
   ready.
5. Run route tests, frontend build, and browser smoke.

## Room Filters Vertical

The next parallel booking-flow settings vertical is the Filters/Rooms tab read
surface.

Contract artifact:
[`BookingRoomFilterSettings`](booking-room-filter-settings-contract.md).

Proposed slices:

1. Define `BookingRoomFilterSettings` request/response/error contract.
2. Add the booking admin frontend API client.
3. Implement or tighten the TypeScript backend route.
4. Update the Filters tab read path to consume the typed client when the route
   is ready.
5. Run route tests, frontend build, and browser smoke.

## Booking Flow Settings Writes

After the Booking Flow settings read paths are migrated, save behavior should
move one surface at a time from legacy broad admin endpoints to typed write
contracts.

Contract artifact:
[`Booking settings write contracts`](booking-settings-write-contracts.md).

Proposed slices:

1. Define typed write contracts for add-ons display settings, guest form,
   benefits, localization, and room filters.
2. Implement typed TypeScript backend write routes.
3. Add booking-admin typed write clients.
4. Update Booking Flow save handlers to use typed write clients.
5. Remove unused legacy booking-admin settings helpers after all consumers are
   gone.

## Cutover Model

Cut over per surface, not per whole product.

During migration, routing can send specific paths to `apps/api` while old paths
continue to hit the Python services. Once a product has enough migrated
surfaces and post-merge smoke coverage, the remaining Python routes can be
retired behind a reviewed cutover plan.

## VAY-901 Booking Parity Checklist

Before making the next Booking stack canonical, include this old-stack parity
batch in cutover smoke:

- VAY-888: Dutch (`nl`, Nederlands) appears in the guest-facing Booking Web
  language picker and the route does not crash before full Dutch copy exists.
- VAY-889: Sri Lankan Rupee (`LKR`) appears in Booking Admin localization
  additional currencies.
- VAY-890: Booking Web does not render Book Direct Benefits when the target
  benefits list is empty or unset.
- VAY-892: Booking Admin add-on reordering persists via target add-on item
  `sortOrder` writes.
- VAY-894: Design Studio exposes the Italiana typography preset.
- VAY-891: child guest-type settings require the split target contract/schema
  follow-up VAY-929 before cutover.

## VAY-945 Post-Rollback Parity Checklist

Include this post-rollback old-stack parity batch in the same Booking cutover
smoke as VAY-901:

- Checkout booking creates must persist the expected quote total/balance and
  reject mismatched submitted totals. Server-authoritative stale quote
  validation remains owned by VAY-927 with the full target quote endpoint.
- Booking Web room cards, detail modals, payment quote requests, and quote
  snapshots must use the same full-stay nightly pricing source for flexible,
  non-refundable, and last-minute discounts.
- Platform media uploads must reject unsupported content types but accept valid
  large-dimension JPG, PNG, and WebP images within the byte limit by generating
  bounded public display variants before storage/display.
