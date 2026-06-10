# BookingGuestFormSettings contract

This contract is the next narrow booking-flow settings vertical in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
after [`BookingAddonSettings`](booking-addon-settings-contract.md). It covers
the booking-admin Guest Form tab read surface for the three guest information
toggles. It does not cover guest checkout form rendering, settings writes, PMS
sync writes, or broader property settings.

The current legacy source is the Booking API property settings response from
`apps/booking-api/app/routers/admin/settings.py`. The booking-admin screen reads
these values through `settingsService.getPropertySettings()` and writes them
through `settingsService.updatePropertySettings()`, followed by a best-effort
PMS sync to `/admin/guest-form-settings`.

## Endpoint

| Field                  | Value                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| Method                 | `GET`                                                            |
| Path                   | `/api/booking/hotels/:hotelId/settings/guest-form`               |
| Route adapter          | `registerBookingSettingsRoutes`                                  |
| Frontend client target | `getBookingGuestFormSettings(input) -> BookingGuestFormSettings` |

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
type BookingGuestFormSettingsRequest = {
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
type BookingGuestFormSettings = {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
};
```

Behavior:

| Field                    | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `specialRequestsEnabled` | Whether the guest form should ask for free-text special requests. |
| `arrivalTimeEnabled`     | Whether the guest form should ask for estimated arrival time.     |
| `guestCountEnabled`      | Whether the guest form should ask for explicit guest count.       |

Rows with `NULL`/missing legacy values default to:

```json
{
  "specialRequestsEnabled": true,
  "arrivalTimeEnabled": false,
  "guestCountEnabled": false
}
```

An authorized hotel with no Booking settings row returns `404`, not a
successful empty object. During staged cutover, the booking-admin Guest Form tab
may still render local optimistic defaults while loading or after a failed
optional fetch.

## Error Contract

```ts
type BookingGuestFormSettingsErrorCategory = "authentication" | "authorization" | "read_model";

type BookingGuestFormSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

type BookingGuestFormSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingGuestFormSettingsErrorCode;
  category: BookingGuestFormSettingsErrorCategory;
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
| No settings row for hotel      | `404`  | `not_found`               | `read_model`     | `Booking hotel guest-form settings not found.`  |
| Repository/read-model error    | `500`  | `read_model_unavailable`  | `read_model`     | `Booking guest-form settings are unavailable.`  |

Expected messages should be stable enough for logging and user-facing category
mapping, but frontend copy should come from the booking-admin client or screen
rather than raw backend messages.

## Scalar Formats

This contract has no money, currency, date, timestamp, pagination, or sorting
fields. All response values are booleans. If future guest-form settings add
localized labels, required/optional modes, or per-market variants, that must be
a contract change.

## Loading And Stale State

The response has no stale-data marker in this slice. The booking-admin client
and screen own loading state.

Current booking-admin compatibility:

- The Guest Form tab initializes local toggle state before the property settings
  request resolves.
- If the optional read fails during staged cutover, the screen may keep local
  defaults and show the existing save behavior.
- The follow-up UI migration should load this read contract through a typed
  client and avoid normalizing legacy snake_case fields inside React state.

## Compatibility Notes

Legacy Booking source fields:

| Legacy field               | Contract field           | Default |
| -------------------------- | ------------------------ | ------- |
| `special_requests_enabled` | `specialRequestsEnabled` | `true`  |
| `arrival_time_enabled`     | `arrivalTimeEnabled`     | `false` |
| `guest_count_enabled`      | `guestCountEnabled`      | `false` |

Legacy PMS compatibility:

- `apps/pms-api/app/routers/admin.py` exposes `/admin/guest-form-settings`
  using the same three legacy field names and defaults.
- `apps/pms-api/app/routers/bookings.py` currently exposes these flags through
  the guest-facing payment-settings response.
- The current booking-admin save flow writes Booking first, then performs a
  best-effort PMS PATCH so guest-facing booking pages pick up the changes.
- This read contract must not change PMS sync behavior. The typed write
  contract keeps PMS sync as non-fatal compatibility behavior until the
  guest-facing flow reads these flags from a Booking-owned or
  distribution-owned model.

Removal condition: the target Booking/checkout settings read model implements
the same response contract and the booking-admin Guest Form tab is cut over
through a typed client.
