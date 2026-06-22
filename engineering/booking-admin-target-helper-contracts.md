# Booking Admin target helper contracts

_VAY-893 contract record. Blocks VAY-884 until the replacement surfaces below
are implemented, smoke-tested, and the legacy helper shims can be deleted._

## Purpose

VAY-883 made the unsupported Booking Admin helper surfaces explicit instead of
pretending that legacy `/admin/*` paths still had working target behavior. This
document defines the remaining target contracts so implementation tickets can
restore the disabled UI paths without inventing routes inside frontend code.

This is planning-only. It does not implement routes, frontend clients, or
compatibility deletion.

## Contract Matrix

| Surface                                 | Current helper surface                                               | Owner                                                       | Target path                                            | Auth policy             | Follow-up |
| --------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ | ----------------------- | --------- |
| Add-on item CRUD                        | `/admin/addons`                                                      | Booking/checkout                                            | `/api/booking/hotels/:hotelId/addon-items`             | Booking settings manage | VAY-896   |
| Promo-code CRUD                         | `/admin/promo-codes`                                                 | Booking/checkout                                            | `/api/booking/hotels/:hotelId/promo-codes`             | Booking settings manage | VAY-897   |
| Custom domain status/connect/disconnect | `/admin/settings/custom-domain*`                                     | Platform/domain verification through a Booking Admin facade | `/api/booking/hotels/:hotelId/custom-domain`           | Booking settings manage | VAY-898   |
| Payment setup/settings writes           | `/admin/payment-settings` and disabled setup writes                  | Finance                                                     | `/api/finance/properties/:propertyId/payment-settings` | Finance property manage | VAY-899   |
| Last-minute discount settings           | `/admin/hotel` setup payload fields and disabled Booking Flow writes | Booking/checkout                                            | `/api/booking/hotels/:hotelId/settings/last-minute`    | Booking settings manage | VAY-900   |

VAY-884 must remain blocked by VAY-896, VAY-897, VAY-898, VAY-899, and VAY-900.
Deleting the helper shims is safe only after those blockers are closed by
merged, accepted replacements.

## Shared Rules

Booking-owned routes use the existing settings authorization model from
`booking-settings-write-contracts.md`:

```ts
type BookingAdminHelperRoutePolicy = {
  permission: "booking.settings.manage";
  entitlement: "booking:booking-engine";
  entitlementStatus: "active";
  resourceType: "booking_hotel";
  resourceId: string; // params.hotelId
  allowedRelationships: ["owner", "operator"];
};
```

Finance-owned payment settings writes use the property finance write policy from
`finance-route-contracts.md`:

```ts
type FinancePaymentSettingsWritePolicy = {
  permission: "pms.finance.manage";
  entitlement: "active finance-capable property entitlement";
  resourceType: "pms_property" | "property";
  resourceId: string; // params.propertyId
  allowedRelationships: ["owner", "finance_manager"];
};
```

All protected routes must call `enforceRoutePolicy` at the route boundary. They
must not authorize through `X-Hotel-Id`, legacy JWT claims, `users.type`,
`users.is_superadmin`, or direct legacy product ownership fields.

Mutation routes are strict JSON contracts. Unknown fields are rejected. Required
fields cannot be omitted. `null` is invalid unless the field is explicitly
nullable below. Money values are major-unit decimal strings in the backend
contract, even when the current Booking Admin component model uses numbers.

Booking Admin routes that accept `:hotelId` use the existing Booking resource
id as the request scope, then resolve the canonical target `propertyId` through
`hotel_catalog.property_source_links`. Implementations must not assume Booking
hotel IDs, PMS hotel IDs, and canonical property IDs are interchangeable.

Shared Booking error vocabulary:

```ts
type BookingAdminHelperErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "not_found"
  | "conflict"
  | "write_model_unavailable";

type BookingAdminHelperError = {
  statusCode: 401 | 403 | 404 | 409 | 422 | 500;
  code: BookingAdminHelperErrorCode;
  category: "authentication" | "authorization" | "validation" | "write_model";
  message: string;
  details?: unknown;
};
```

## Booking Hotel Property Link

Finance routes use canonical `propertyId`, while several Booking Admin screens
currently start from a Booking hotel id or legacy property settings payload.
VAY-899 must remove that legacy dependency before enabling writes.

Target resolver contract:

| Method | Path                                         | Behavior                                                                                                                     |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/booking/hotels/:hotelId/property-link` | Resolve the Booking hotel resource to the canonical property id needed by Finance and platform/domain verification commands. |

```ts
type BookingHotelPropertyLinkResponse = {
  hotelId: string;
  propertyId: string;
  resourceLinks: {
    bookingHotel: true;
    pmsProperty: boolean;
    financeProperty: boolean;
  };
};
```

This route uses the Booking settings manage policy for `hotelId`. It returns
only opaque target IDs and coarse link availability. It must not expose raw
legacy source table names, source ids, or ownership internals. VAY-899 may reuse
an existing target selected-property response only if it returns the same
canonical `propertyId` without calling `/admin/settings/property`.

## Add-on Item CRUD

Target routes:

| Method   | Path                                                    | Behavior                                                              |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET`    | `/api/booking/hotels/:hotelId/addon-items`              | List active and inactive add-on items for admin editing.              |
| `POST`   | `/api/booking/hotels/:hotelId/addon-items`              | Create one add-on item.                                               |
| `PATCH`  | `/api/booking/hotels/:hotelId/addon-items/:addonItemId` | Partially update editable fields.                                     |
| `DELETE` | `/api/booking/hotels/:hotelId/addon-items/:addonItemId` | Soft-delete or archive the item so historical bookings remain intact. |

```ts
type AddonPricingModel = "per_stay" | "per_night" | "per_guest" | "per_guest_night";

type BookingAdminAddonItem = {
  addonItemId: string;
  hotelId: string;
  propertyId: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  category: "dining" | "experience" | "transport" | "wellness" | "other";
  imageUrl: string | null;
  duration: string | null;
  pricingModel: AddonPricingModel;
  publicVisible: boolean;
  status: "active" | "disabled" | "retired";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ListBookingAdminAddonItemsResponse = {
  addonItems: BookingAdminAddonItem[];
};

type CreateBookingAdminAddonItemRequest = {
  name: string;
  description?: string;
  price: string;
  currency: string;
  category: BookingAdminAddonItem["category"];
  imageUrl?: string | null;
  duration?: string | null;
  pricingModel?: AddonPricingModel;
  publicVisible?: boolean;
  status?: "active" | "disabled";
  sortOrder?: number;
};

type UpdateBookingAdminAddonItemRequest = Partial<CreateBookingAdminAddonItemRequest>;
```

Validation:

- `name` is trimmed and must be non-empty.
- `price` must be a non-negative decimal string.
- `currency` must be an uppercase ISO-4217 code.
- `pricingModel` defaults to `per_stay`. The frontend maps the current
  `perPerson` and `perNight` booleans as: neither -> `per_stay`, per-night only
  -> `per_night`, per-person only -> `per_guest`, both -> `per_guest_night`.
- `DELETE` sets `status: "retired"` or equivalent archival state and must not
  remove historical booking selections. It returns `204` on success.

## Promo-code CRUD

The target schema currently stores applied promo outcomes in
`booking.promo_applications`; that table is not the admin promo-rule write
model. VAY-897 must add or select a Booking-owned promo definition/rule model
before wiring these routes. Public quote validation may consume that model, but
admin CRUD must not write directly to `booking.promo_applications`.

Target routes:

| Method   | Path                                                    | Behavior                              |
| -------- | ------------------------------------------------------- | ------------------------------------- |
| `GET`    | `/api/booking/hotels/:hotelId/promo-codes`              | List admin promo codes for the hotel. |
| `POST`   | `/api/booking/hotels/:hotelId/promo-codes`              | Create one promo code.                |
| `PATCH`  | `/api/booking/hotels/:hotelId/promo-codes/:promoCodeId` | Partially update editable fields.     |
| `DELETE` | `/api/booking/hotels/:hotelId/promo-codes/:promoCodeId` | Disable or archive the promo code.    |

```ts
type BookingAdminPromoCode = {
  promoCodeId: string;
  hotelId: string;
  propertyId: string;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  currency: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  maxUses: number | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
};

type ListBookingAdminPromoCodesResponse = {
  promoCodes: BookingAdminPromoCode[];
};

type CreateBookingAdminPromoCodeRequest = {
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: string;
  currency?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  isActive?: boolean;
  maxUses?: number | null;
};

type UpdateBookingAdminPromoCodeRequest = Partial<CreateBookingAdminPromoCodeRequest>;
```

Validation:

- `code` is trimmed, uppercased, and unique per hotel among non-archived promo
  codes. Duplicates return `409 conflict`.
- Percentage discounts must be greater than `0` and no more than `100`.
- Fixed discounts require `currency` and a positive decimal `discountValue`.
- Date strings use `YYYY-MM-DD`. `validUntil` cannot be earlier than
  `validFrom`.
- `maxUses` is either `null` or an integer greater than `0`.
- `DELETE` preserves `useCount` history and returns `204`.

Public Booking Web promo validation remains a separate checkout/public route
slice. It may consume the same Booking promo model, but it must not expose admin
metadata.

## Custom Domain

This route family is a Booking Admin facade over platform/domain verification
and hotel-catalog domain projection state. The facade authorizes the Booking
hotel resource for the logged-in organization, resolves the canonical
`propertyId`, and then dispatches domain verification commands. It must not
create a Booking-only custom-domain store.

Target routes:

| Method   | Path                                         | Behavior                                                             |
| -------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `GET`    | `/api/booking/hotels/:hotelId/custom-domain` | Return current admin verification state.                             |
| `PUT`    | `/api/booking/hotels/:hotelId/custom-domain` | Connect or replace the requested domain and return DNS instructions. |
| `DELETE` | `/api/booking/hotels/:hotelId/custom-domain` | Disconnect the custom domain from the hotel.                         |

```ts
type BookingCustomDomainStatus = "not_configured" | "pending" | "verified" | "failed";

type BookingCustomDomainDnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  status: "pending" | "verified" | "failed";
};

type BookingAdminCustomDomainResponse = {
  hotelId: string;
  propertyId: string;
  configured: boolean;
  domain: string | null;
  status: BookingCustomDomainStatus;
  sslStatus: "not_configured" | "pending" | "active" | "failed";
  dnsRecords: BookingCustomDomainDnsRecord[];
  verificationErrors: string[];
  checkedAt: string | null;
  updatedAt: string | null;
};

type UpsertBookingAdminCustomDomainRequest = {
  domain: string;
};
```

Validation and behavior:

- `domain` must be a normalized hostname, not a URL, path, wildcard, or localhost
  value.
- `PUT` replaces the previous pending or verified domain for that hotel and
  returns the DNS records needed for verification.
- Verification state must be shared with the Booking Web host-resolution target
  model through platform/domain verification, hotel catalog, and distribution
  projections.
- `DELETE` disconnects the domain and returns `204`.

## Payment Settings Writes

The payment setup/settings write route is Finance-owned and extends the
existing `finance-route-contracts.md` payment-settings read contract.

Target route:

| Method  | Path                                                   | Behavior                                                                    |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `PATCH` | `/api/finance/properties/:propertyId/payment-settings` | Partially update admin payment settings with an idempotent finance command. |

```ts
type UpdateFinancePaymentSettingsCommand = {
  commandId: string;
  idempotencyKey: string;
  paymentSettings: Partial<{
    paymentsEnabled: boolean;
    paymentProvider: "stripe" | "xendit" | "vayada" | "manual" | "bank_transfer";
    acceptedMethods: Array<
      | "card"
      | "pay_at_property"
      | "xendit"
      | "cash"
      | "bank_transfer"
      | "manual_card"
      | "wallet"
      | "other"
    >;
    defaultCurrency: string;
    supportedCurrencies: string[];
    depositPolicy: Record<string, string | number | boolean | null>;
    refundPolicy: Record<string, string | number | boolean | null>;
    taxPolicy: Record<string, string | number | boolean | null>;
    statementDescriptor: string | null;
    requiresManualReview: boolean;
  }>;
};
```

The success response is the normalized
`FinancePaymentSettingsResponse` from `finance-route-contracts.md`.

Behavior:

- The route must enforce finance write authorization, not Booking settings
  authorization.
- Booking Admin setup/settings must use the target property-link resolver above,
  or an equivalent target selected-property response, to obtain canonical
  `propertyId` before calling Finance. It must not keep using
  `/admin/settings/property` as the source of that id.
- Provider account creation and onboarding remain provider-account command
  routes. Payment settings writes may reference provider choices, but must not
  return provider secrets, bank details, tokens, or signing-secret refs.
- Currency changes must follow the finance contract: persist the settings change
  and enqueue audited idempotent jobs when redenomination is required; do not
  inline-convert room rates, add-on prices, booking amounts, or payments.

## Last-minute Discount Settings

Target routes:

| Method | Path                                                | Behavior                                         |
| ------ | --------------------------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/booking/hotels/:hotelId/settings/last-minute` | Return the stored last-minute discount settings. |
| `PUT`  | `/api/booking/hotels/:hotelId/settings/last-minute` | Replace the full last-minute settings surface.   |

```ts
type BookingLastMinuteTier = {
  daysBeforeMin: number;
  daysBeforeMax: number | null;
  discountPercent: number;
};

type BookingLastMinuteSettings = {
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: BookingLastMinuteTier[];
  updatedAt: string;
};

type UpdateBookingLastMinuteSettingsRequest = {
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: BookingLastMinuteTier[];
};
```

Validation:

- `PUT` is full-surface replacement, matching the existing Booking settings
  write pattern.
- If `enabled` is `false`, `tiers` must be empty and `stackWithPromo` must be
  `false`.
- If `enabled` is `true`, at least one tier is required.
- `daysBeforeMin` must be an integer greater than or equal to `0`.
- `daysBeforeMax` is either `null` for an open upper bound or an integer greater
  than or equal to `daysBeforeMin`.
- Tier day ranges must not overlap.
- `discountPercent` must be greater than `0` and no more than `100`.

Quote calculation rollout is intentionally separate. This route stores the admin
settings and exposes them to Booking/checkout projections; implementation work
must not silently change guest quote behavior without a covered checkout slice.

## Migration Order

1. VAY-896 implements add-on item routes and moves Booking Admin add-on item
   callers off `/admin/addons`.
2. VAY-897 implements promo-code routes and moves Booking Admin promo-code
   callers off `/admin/promo-codes`.
3. VAY-898 implements custom-domain admin routes and shares verification state
   with Booking Web host resolution.
4. VAY-899 implements Finance payment-settings writes and moves Booking Admin
   setup/settings payment choices onto the Finance client.
5. VAY-900 implements last-minute settings and moves setup/Booking Flow callers
   off `/admin/hotel` or disabled placeholders.
6. VAY-884 deletes `bookingAdminCompat` helper shims after the replacement
   routes, typed clients, tests, and smoke checks are accepted.

Each implementation slice should include route policy tests, frontend client
route-construction tests, and the focused Booking Admin smoke path for the
surface it restores.
