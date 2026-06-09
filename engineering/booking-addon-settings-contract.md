# BookingAddonSettings contract

This contract is the next narrow booking-flow settings vertical from
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
after [`BookingReservationList`](booking-reservation-list-contract.md). It
covers the booking-admin add-on display settings shown in the booking-flow
Add-ons tab, not add-on CRUD or guest checkout add-on selection.

The current TypeScript route adapter lives in
[`apps/api/src/routes/bookingSettings.ts`](../apps/api/src/routes/bookingSettings.ts)
and exports the `BookingAddonSettingsResponse` shape. Follow-up tickets should
tighten the route and add a booking-admin typed client against this contract.

## Endpoint

| Field                  | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| Method                 | `GET`                                                    |
| Path                   | `/api/booking/hotels/:hotelId/settings/addons`           |
| Route adapter          | `registerBookingSettingsRoutes`                          |
| Frontend client target | `getBookingAddonSettings(input) -> BookingAddonSettings` |

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
type BookingAddonSettingsRequest = {
  params: {
    hotelId: string;
  };
  query: Record<string, never>;
};
```

There is no request body and no public query parameter for this read slice.
Future write/update behavior must be defined by a separate contract before
implementation.

## Response

```ts
type BookingAddonSettings = {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
};
```

Behavior:

| Field                   | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `showAddonsStep`        | Whether guest checkout should show the add-ons step.                    |
| `groupAddonsByCategory` | Whether add-ons should be grouped by category in the guest-facing flow. |

Rows with `NULL`/missing legacy values default to:

```json
{
  "showAddonsStep": true,
  "groupAddonsByCategory": true
}
```

An authorized hotel with no settings row returns `404`, not a successful empty
object. This preserves current booking-admin/Python compatibility for a missing
property record. The frontend may still render local optimistic defaults while
loading or after a failed optional fetch.

## Error Contract

```ts
type BookingAddonSettingsErrorCategory = "authentication" | "authorization" | "read_model";

type BookingAddonSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

type BookingAddonSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingAddonSettingsErrorCode;
  category: BookingAddonSettingsErrorCategory;
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
| No settings row for hotel      | `404`  | `not_found`               | `read_model`     | `Booking hotel addon settings not found.`       |
| Repository/read-model error    | `500`  | `read_model_unavailable`  | `read_model`     | `Booking add-on settings are unavailable.`      |

Expected messages should be stable enough for logging and user-facing category
mapping, but frontend copy should still come from the booking-admin client or
screen rather than from raw backend messages.

## Scalar Formats

This contract has no money, currency, date, timestamp, pagination, or sorting
fields. All response values are booleans. If future settings add money, dates,
or localized strings, that must be a contract change.

## Loading And Stale State

The response has no stale-data marker in this slice. The booking-admin client
and screen own loading state. During staged cutover, the Add-ons tab may keep
the current local fallback of `{ showAddonsStep: true, groupAddonsByCategory:
true }` when the optional settings fetch fails, but route tests should still
cover the backend error contract.

## Compatibility Notes

The current legacy source is `booking_hotels.show_addons_step` and
`booking_hotels.group_addons_by_category`. This is a temporary compatibility
read model while the target Booking/checkout settings model is built. The
TypeScript route must continue to depend on a `BookingSettingsReadRepository`
interface, not on frontend state or Python response quirks.

Removal condition: the target Booking/checkout settings read model implements
the same response contract and the booking-admin Add-ons tab is cut over through
a typed client.
