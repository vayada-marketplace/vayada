# BookingRoomFilterSettings contract

This contract is the next narrow booking-flow settings vertical in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
alongside [`BookingBenefitsSettings`](booking-benefits-settings-contract.md) and
after [`BookingGuestFormSettings`](booking-guest-form-settings-contract.md). It
covers the booking-admin Booking Flow Filters/Rooms tab read surface for guest
room filters: the enabled filter keys, owner-defined custom filter labels, and
filter-to-room assignments. It does not cover filter writes, guest-facing
filter rendering, hero/branding design settings, or PMS room inventory.

The current legacy source is the Booking API design settings response from
`apps/booking-api/app/routers/admin/design.py` (`GET /admin/settings/design`).
The booking-admin screen reads these values through
`settingsService.getDesignSettings()` and writes them through
`settingsService.updateDesignSettings()`. Only the three filter fields of that
broad design payload are in scope here; hero image, heading, subtext, colors,
and font pairing remain on the legacy design settings surface.

## Endpoint

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Method                 | `GET`                                                              |
| Path                   | `/api/booking/hotels/:hotelId/settings/room-filters`               |
| Route adapter          | `registerBookingSettingsRoutes`                                    |
| Frontend client target | `getBookingRoomFilterSettings(input) -> BookingRoomFilterSettings` |

`hotelId` is the Booking product hotel id. It is the resource scope for the
settings row and for every authorization check.

## Authorization

The route is protected and must use `enforceRoutePolicy` at the route boundary.

Required checks:

| Check                 | Contract value                              |
| --------------------- | ------------------------------------------- |
| Permission            | `booking.settings.manage`                   |
| Entitlement           | active `booking:booking-engine`             |
| Entitlement resource  | `booking_hotel` with `resourceId = hotelId` |
| Linked resource       | `booking_hotel` with `resourceId = hotelId` |
| Allowed relationships | `owner`, `operator`                         |

Authentication failures return `401`. Permission, entitlement, inactive
entitlement, or linked-resource failures return `403`.

## Request

```ts
type BookingRoomFilterSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};
```

There is no request body and no public query parameter for this read slice.
Typed write behavior is defined separately in
[`booking-settings-write-contracts.md`](booking-settings-write-contracts.md).

## Response

```ts
type BookingRoomFilterSettings = {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
};
```

Behavior:

| Field            | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `bookingFilters` | Ordered filter keys enabled for guest room search (built-in keys or custom filter keys). |
| `customFilters`  | Map of custom filter key to the owner-typed display label.                               |
| `filterRooms`    | Map of filter key to the PMS room ids the filter applies to.                             |

Filter keys are stable strings. Built-in keys come from the booking-admin
catalog (`apps/booking-admin/lib/constants/filters.ts`, e.g. `oceanView`);
custom keys are derived from the owner-typed label by the write path (the
current booking-admin UI lowercases the trimmed label and replaces whitespace
with underscores). Key derivation is owned by the write path; this read
contract returns stored keys verbatim. The read contract preserves stored key
order and label strings. It does not translate labels, validate room ids
against PMS inventory, or attach stable ids beyond the filter keys themselves.
Stale or unknown PMS room ids in `filterRooms` are returned verbatim; the
screen already falls back to rendering the raw id when no room name matches.

Rows with `NULL`, missing, malformed, or wrong-shaped legacy values default
per field to:

```json
{
  "bookingFilters": [],
  "customFilters": {},
  "filterRooms": {}
}
```

Shape rules for legacy JSONB content:

- `bookingFilters` must be an array; non-array values coerce to `[]` and
  non-string entries are dropped.
- `customFilters` must be an object; non-object values coerce to `{}` and
  entries with non-string values are dropped.
- `filterRooms` must be an object of arrays; non-object values coerce to `{}`,
  non-array entry values coerce to `[]`, and non-string room ids are dropped.

This is an intentional, documented improvement over the legacy endpoint, which
returns a `500` when a stored JSONB value parses to a wrong shape.

An authorized hotel with no Booking settings row returns the default empty
response above, not `404`. This matches the current legacy design settings
behavior, which returns empty defaults when the hotel record is missing, and
intentionally differs from the addons and guest-form settings contracts. The
empty response is also the meaningful product state for a hotel that has not
configured filters: the Filters tab renders the feature toggle off.

The empty response does not weaken resource scoping: `enforceRoutePolicy` runs
before any read-model lookup, so a caller without linked-resource access to
`hotelId` receives `403` and never observes whether a settings row exists.

## Error Contract

```ts
type BookingRoomFilterSettingsErrorCategory = "authentication" | "authorization" | "read_model";

type BookingRoomFilterSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

type BookingRoomFilterSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingRoomFilterSettingsErrorCode;
  category: BookingRoomFilterSettingsErrorCategory;
  message: string;
};
```

Expected mapping:

| Condition                      | Status | Code                      | Category         | Message                                         |
| ------------------------------ | ------ | ------------------------- | ---------------- | ----------------------------------------------- |
| Missing bearer/session         | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`             |
| Invalid bearer/session         | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`             |
| Missing permission             | `403`  | `missing_permission`      | `authorization`  | `Missing required booking settings permission.` |
| Missing entitlement            | `403`  | `missing_entitlement`     | `authorization`  | `Missing active booking engine entitlement.`    |
| Inactive entitlement           | `403`  | `inactive_entitlement`    | `authorization`  | `Booking engine entitlement is not active.`     |
| Missing linked-resource access | `403`  | `missing_resource_access` | `authorization`  | `Missing booking hotel access.`                 |
| Repository/read-model error    | `500`  | `read_model_unavailable`  | `read_model`     | `Booking room-filter settings are unavailable.` |

There is no `404`/`not_found` case in this slice because a missing settings row
returns the default empty response. Expected messages should be stable enough
for logging and user-facing category mapping, but frontend copy should come
from the booking-admin client or screen rather than raw backend messages.

## Scalar Formats

This contract has no money, currency, date, timestamp, pagination, sorting, or
filtering request fields. All response values are plain strings, string arrays,
or string-keyed maps. If future filter settings add ordering metadata,
localized labels, room-type scoping, or per-market variants, that must be a
contract change.

## Loading And Stale State

The response has no stale-data marker in this slice. The booking-admin client
and screen own loading state.

Current booking-admin compatibility:

- The Filters tab initializes local state as empty filters before the design
  settings request resolves, and derives its enabled toggle from
  `bookingFilters.length > 0`.
- If the optional read fails during staged cutover, the screen may keep the
  empty local defaults and preserve existing save behavior. A user who saves on
  top of that fallback can overwrite stored filters with empty values; that
  failure mode already exists with the legacy design settings fetch and is
  intentionally preserved, not introduced, by this read migration.
- Room names shown next to assignments come from a separate PMS rooms fetch;
  that fetch is out of scope and unchanged by this contract.
- The follow-up UI migration should load this read contract through a typed
  client and avoid normalizing legacy snake_case design fields inside React
  state.

## Compatibility Notes

Legacy Booking source fields (all JSONB on `booking_hotels`):

| Legacy field      | Contract field   | Default |
| ----------------- | ---------------- | ------- |
| `booking_filters` | `bookingFilters` | `[]`    |
| `custom_filters`  | `customFilters`  | `{}`    |
| `filter_rooms`    | `filterRooms`    | `{}`    |

- The columns were added by Booking migrations `007_add_booking_filters.sql`,
  `010_add_custom_filters.sql`, and `018_add_filter_rooms.sql` with empty JSONB
  defaults.
- The legacy `GET /admin/settings/design` endpoint returns these fields inside
  the broad design payload and falls back to empty defaults when the hotel row
  is missing or a stored value is a malformed JSON string.
- The current booking-admin save flow writes all three fields through
  `PATCH /admin/settings/design` (`settingsService.updateDesignSettings()`).
  The typed write replacement for the Booking Flow Filters tab is defined in
  [`booking-settings-write-contracts.md`](booking-settings-write-contracts.md).
- Guest-facing booking-web room filtering continues to read filters through the
  legacy public surfaces. This read contract must not change guest-facing
  behavior.

Follow-up migration target: the booking-flow Filters tab (the `rooms` tab in
`apps/booking-admin/app/(app)/booking-flow/page.tsx`) consumes this contract
through a typed client once the route ships.

Removal condition: the target Booking/checkout settings read model implements
the same response contract and the booking-admin Filters tab is cut over
through a typed client.
