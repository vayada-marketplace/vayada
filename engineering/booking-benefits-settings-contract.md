# BookingBenefitsSettings contract

This contract is the next narrow booking-flow settings vertical in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
after [`BookingGuestFormSettings`](booking-guest-form-settings-contract.md). It
covers the booking-admin Benefits tab read surface for hotel-level Book Direct
Benefits. It does not cover benefits writes, room-type benefits, guest checkout
rendering changes, or PMS sync behavior.

The current legacy source is the Booking API `/admin/benefits` response from
`apps/booking-api/app/routers/admin/benefits.py`. The booking-admin screen reads
these values through `settingsService.getBenefits()` and writes them through
`settingsService.updateBenefits()`.

## Endpoint

| Field                  | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Method                 | `GET`                                                          |
| Path                   | `/api/booking/hotels/:hotelId/settings/benefits`               |
| Route adapter          | `registerBookingSettingsRoutes`                                |
| Frontend client target | `getBookingBenefitsSettings(input) -> BookingBenefitsSettings` |

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
type BookingBenefitsSettingsRequest = {
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
type BookingBenefitsSettings = {
  benefits: string[];
};
```

Behavior:

| Field      | Meaning                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `benefits` | Ordered hotel-level Book Direct Benefits displayed to guests when set. |

`benefits` contains owner-configured display strings. Values may be one of the
predefined booking-admin options or a custom string typed by the hotel owner.
The read contract preserves the stored order and string values. It does not
translate, deduplicate, categorize, or attach stable ids to individual benefit
labels.

Rows with `NULL`, missing, malformed, or non-list legacy values default to:

```json
{
  "benefits": []
}
```

An authorized hotel with no benefits row also returns the empty list response,
not `404`. This intentionally differs from the add-ons and guest-form settings
contracts because the current legacy `/admin/benefits` behavior treats missing
or unset benefits as an empty hotel-level list.

## Error Contract

```ts
type BookingBenefitsSettingsErrorCategory = "authentication" | "authorization" | "read_model";

type BookingBenefitsSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable";

type BookingBenefitsSettingsError = {
  statusCode: 401 | 403 | 500;
  code: BookingBenefitsSettingsErrorCode;
  category: BookingBenefitsSettingsErrorCategory;
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
| Repository/read-model error    | `500`  | `read_model_unavailable`  | `read_model`     | `Booking benefits settings are unavailable.`    |

Expected messages should be stable enough for logging and user-facing category
mapping, but frontend copy should come from the booking-admin client or screen
rather than raw backend messages.

## Scalar Formats

This contract has no money, currency, date, timestamp, pagination, sorting, or
filtering fields. The response is an ordered array of plain strings. If future
benefits need stable ids, localized labels, per-room overrides, categories, or
visibility rules, that must be a contract change.

## Loading And Stale State

The response has no stale-data marker in this slice. The booking-admin client
and screen own loading state.

Current booking-admin compatibility:

- The Benefits tab initializes local state as an empty list before the benefits
  request resolves.
- If the optional read fails during staged cutover, the screen may keep the
  empty list fallback and preserve existing save behavior.
- The follow-up UI migration should load this read contract through a typed
  client and avoid calling `settingsService.getBenefits()` directly from React
  state setup.

## Compatibility Notes

Legacy Booking source:

| Legacy field              | Contract field | Default |
| ------------------------- | -------------- | ------- |
| `booking_hotels.benefits` | `benefits`     | `[]`    |

The legacy Booking API stores benefits as hotel-level JSONB on
`booking_hotels.benefits`. The existing `PUT /admin/benefits` behavior replaces
the whole list and preserves custom owner-typed strings.

Guest-facing display:

- The booking-admin Benefits tab describes these labels as Book Direct Benefits
  that appear in the room detail modal and apply to all rooms.
- The guest-facing booking web currently renders room-level `benefits: string[]`
  in `RoomDetailModal` when the list is non-empty.
- PMS compatibility currently also has hotel-level benefits on `pms.hotels`,
  and room search code passes hotel benefits into room responses. This read
  contract must not change guest checkout display or PMS sync behavior.

Removal condition: the target Booking/checkout settings read model implements
the same response contract and the booking-admin Benefits tab is cut over
through a typed client.
