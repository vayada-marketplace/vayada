# BookingLocalizationSettings contract

This contract is the next narrow booking-flow settings vertical in
[`frontend-backend-contract-migration.md`](frontend-backend-contract-migration.md),
after [`BookingBenefitsSettings`](booking-benefits-settings-contract.md). It
covers the booking-admin Localization tab read surface for default currency,
default language, supported currencies, and supported languages. It does not
cover localization writes, the header currency switcher, setup wizard writes,
guest checkout locale selection, or broader property settings.

The current legacy source is the Booking API property settings response from
`apps/booking-api/app/routers/admin/settings.py`. The booking-admin screen reads
these values through `settingsService.getPropertySettings()` and writes them
through `settingsService.updatePropertySettings()`.

## Endpoint

| Field                  | Value                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Method                 | `GET`                                                                  |
| Path                   | `/api/booking/hotels/:hotelId/settings/localization`                   |
| Route adapter          | `registerBookingSettingsRoutes`                                        |
| Frontend client target | `getBookingLocalizationSettings(input) -> BookingLocalizationSettings` |

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
type BookingLocalizationSettingsRequest = {
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
type BookingLocalizationSettings = {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
};
```

Behavior:

| Field                 | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `defaultCurrency`     | Property default currency used by booking-admin and checkout. |
| `defaultLanguage`     | Property default language used by booking-admin and checkout. |
| `supportedCurrencies` | Currency codes the property allows guests to select.          |
| `supportedLanguages`  | Language codes the property allows guests to select.          |

Rows with `NULL` or missing scalar values, and `NULL`, missing, or malformed
legacy array values, default to:

```json
{
  "defaultCurrency": "EUR",
  "defaultLanguage": "en",
  "supportedCurrencies": [],
  "supportedLanguages": ["en"]
}
```

The route should preserve the current Booking API model defaults from
`HOTEL_FIELD_DEFAULTS`. An authorized request for an unknown Booking hotel id
returns `404`, not a successful default object. During staged cutover, the
booking-admin Localization tab may still render local optimistic defaults while
loading or after a failed optional fetch.

If a legacy array field contains a valid JSON value that is not a list, the
target TypeScript route should coerce it to the contract default instead of
leaking malformed state to the frontend. This is intentional route hardening,
not legacy Python parity, and should be covered by route tests.

## Error Contract

```ts
type BookingLocalizationSettingsErrorCategory = "authentication" | "authorization" | "read_model";

type BookingLocalizationSettingsErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "not_found"
  | "read_model_unavailable";

type BookingLocalizationSettingsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: BookingLocalizationSettingsErrorCode;
  category: BookingLocalizationSettingsErrorCategory;
  message: string;
};
```

Expected mapping:

| Condition                      | Status | Code                      | Category         | Message                                          |
| ------------------------------ | ------ | ------------------------- | ---------------- | ------------------------------------------------ |
| Missing bearer/session         | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`              |
| Invalid bearer/session         | `401`  | `unauthenticated`         | `authentication` | `A valid access token is required.`              |
| Missing permission             | `403`  | `missing_permission`      | `authorization`  | `Missing required booking settings permission.`  |
| Missing entitlement            | `403`  | `missing_entitlement`     | `authorization`  | `Missing active booking engine entitlement.`     |
| Inactive entitlement           | `403`  | `inactive_entitlement`    | `authorization`  | `Booking engine entitlement is not active.`      |
| Missing linked-resource access | `403`  | `missing_resource_access` | `authorization`  | `Missing booking hotel access.`                  |
| Unknown Booking hotel id       | `404`  | `not_found`               | `read_model`     | `Booking hotel localization settings not found.` |
| Repository/read-model error    | `500`  | `read_model_unavailable`  | `read_model`     | `Booking localization settings are unavailable.` |

Expected messages should be stable enough for logging and user-facing category
mapping, but frontend copy should come from the booking-admin client or screen
rather than raw backend messages.

## Scalar Formats

Currency values are string currency codes. Stored Booking data should be
uppercase ISO 4217 three-letter codes when possible, but this read route must
preserve stored strings until a write contract owns validation and migration.
Legacy rows may or may not include `defaultCurrency` in `supportedCurrencies`.

Language values are string locale codes. Stored Booking data should be BCP
47-compatible where possible, but this read route must preserve current legacy
values instead of translating, expanding, or rejecting them.
Legacy rows may or may not include `defaultLanguage` in `supportedLanguages`.

This contract has no money amounts, rounding behavior, date, timestamp,
pagination, sorting, or filtering fields.

## Loading And Stale State

The response has no stale-data marker in this slice. The booking-admin client
and screen own loading state.

Current booking-admin compatibility:

- The Localization tab initializes local state as `EUR`, `en`, `[]`, and `[]`
  before the property settings request resolves.
- If the optional read fails during staged cutover, the screen may keep local
  defaults and preserve existing save behavior.
- The follow-up UI migration should load this read contract through a typed
  client and avoid normalizing legacy snake_case fields inside React state.

## Compatibility Notes

Legacy Booking source fields:

| Legacy field           | Contract field        | Default  |
| ---------------------- | --------------------- | -------- |
| `currency`             | `defaultCurrency`     | `EUR`    |
| `default_language`     | `defaultLanguage`     | `en`     |
| `supported_currencies` | `supportedCurrencies` | `[]`     |
| `supported_languages`  | `supportedLanguages`  | `["en"]` |

Legacy write compatibility:

- The booking-admin Localization tab currently saves through
  `settingsService.updatePropertySettings()` with `default_currency`,
  `default_language`, `supported_currencies`, and `supported_languages`.
- `apps/booking-admin/components/layout/Header.tsx` can independently update
  `default_currency` through the same legacy property settings write path.
- `apps/booking-admin/app/setup/page.tsx` can also write localization fields
  during setup. This read contract must not change setup behavior.
- A future write contract must decide whether localization writes remain on the
  broad property settings endpoint or move to a dedicated typed endpoint.

Removal condition: the target Booking/checkout settings read model implements
the same response contract and the booking-admin Localization tab is cut over
through a typed client.
