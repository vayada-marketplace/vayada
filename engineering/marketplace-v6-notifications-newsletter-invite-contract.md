# Marketplace V6 notifications, newsletter, and invite-code contract

This is the decision-first contract slice for marketplace vertical **V6** from
[`marketplace-route-migration-inventory.md`](marketplace-route-migration-inventory.md).
It covers:

- legacy `/notifications*` disposition;
- newsletter preference read/write contract;
- invite-code admin CRUD and public setup lookup/redeem contract;
- the consumer map needed before the TypeScript route cutover.

The TypeScript backend target owner is `domain-marketplace`. The target tables
already exist in `packages/backend-migration/migrations/0008_marketplace.sql`:
`marketplace.marketplace_notifications`, `marketplace.newsletter_preferences`,
and `marketplace.invite_codes`.

## Decision

### Notifications

Do **not** port `GET /notifications` or `POST /notifications/{id}/read` as V6
HTTP routes.

Rationale:

- No frontend currently calls either route. The only references are the legacy
  Python route itself and `NotificationRepository`.
- `marketplace_notifications` still migrates and remains marketplace-owned.
  This preserves product notification history, read-state parity, and future
  Ask Intelligence / marketplace evidence inputs.
- Existing notification creation is a product side effect of admin creator
  approval. That creation behavior belongs with the marketplace admin/user
  lifecycle cutover, not with an unconsumed inbox route.

V6 therefore retires the user-facing notification inbox/read HTTP surface from
the target route plan while preserving the product-owned table and migration
parity. A future ticket may add a new notification-center contract only after a
frontend consumer exists.

### Newsletter

Migrate the authenticated newsletter preference surface as marketplace-owned
user communication preferences:

| Method | Path                                      | Consumer          |
| ------ | ----------------------------------------- | ----------------- |
| `GET`  | `/api/marketplace/newsletter/preferences` | `marketplace-web` |
| `PUT`  | `/api/marketplace/newsletter/preferences` | `marketplace-web` |

This is not a platform email-delivery/job state table. Weekly send mechanics
remain outside this slice and should move to jobs/events when newsletter
delivery is migrated.

### Invite codes

Migrate invite-code admin CRUD plus public setup lookup/redeem together:

| Method   | Path                                          | Consumer        |
| -------- | --------------------------------------------- | --------------- |
| `GET`    | `/api/marketplace/admin/invite-codes`         | `vayada-admin`  |
| `POST`   | `/api/marketplace/admin/invite-codes`         | `vayada-admin`  |
| `DELETE` | `/api/marketplace/admin/invite-codes/{id}`    | `vayada-admin`  |
| `GET`    | `/api/marketplace/invite-codes/{code}`        | `booking-admin` |
| `POST`   | `/api/marketplace/invite-codes/{code}/redeem` | `booking-admin` |

The booking-admin setup flow is part of the same cutover. It currently uses raw
`fetch` against `NEXT_PUBLIC_MARKETPLACE_API_URL`; V6 implementation must add a
typed booking-admin invite-code client and update `apps/booking-admin/app/setup/page.tsx`
in the same PR that routes public lookup/redeem to TypeScript.

## Consumer map

| Surface       | Current route(s)                                              | Current consumers                                                                              | Target action                                                                                                    |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Notifications | `GET /notifications`, `POST /notifications/{id}/read`         | None found in `marketplace-web`, `vayada-admin`, or `booking-admin`                            | Retire HTTP routes from V6 target; keep `marketplace.marketplace_notifications` migration and product ownership. |
| Newsletter    | `GET/PUT /newsletter/preferences`                             | `apps/marketplace-web/app/settings/newsletter/page.tsx` via `services/api/newsletter.ts`       | Replace with typed marketplace-web client for `/api/marketplace/newsletter/preferences`.                         |
| Invite admin  | `/admin/invite-codes*`                                        | `apps/vayada-admin/app/dashboard/invite-codes/page.tsx` via `services/api/inviteCodes.ts`      | Replace with typed vayada-admin client for `/api/marketplace/admin/invite-codes*`.                               |
| Invite public | `/api/invite-codes/{code}`, `/api/invite-codes/{code}/redeem` | `apps/booking-admin/app/setup/page.tsx` raw `fetch` lookup/redeem in the property setup wizard | Add typed booking-admin client and cut over lookup/redeem with the route migration.                              |

## Authorization

### Newsletter

Authenticated marketplace user.

Target route requirements:

- Resolve `RequestContext`.
- Enforce a marketplace profile/session policy at the route boundary.
- Read/write only the current internal `userId`.
- Use `organizationId` from the selected organization when present; keep null
  as a migration-compatible fallback for legacy user-only preferences.

### Invite admin

Platform admin.

Target route requirements:

- Resolve `RequestContext`.
- Enforce platform admin permission at the route boundary.
- `createdByUserId` is the authenticated internal user.
- Creation accepts only the setup payload needed by booking-admin onboarding;
  no arbitrary side effects.

### Invite public lookup

Anonymous read.

This is an explicit public route because the setup welcome screen validates an
invite code before the hotel setup wizard is submitted. It must return only the
setup payload needed to prefill booking-admin and must never expose creator
organization IDs, creator profile IDs, `createdByUserId`, `redeemedByUserId`, or
admin audit fields.

### Invite redeem

Authenticated booking-admin setup user.

Target route requirements:

- Resolve `RequestContext`.
- Mark the code redeemed by the authenticated internal `userId`.
- The redeem call remains best-effort from booking-admin after setup save, but
  the backend update itself must be idempotent for repeated submission by the
  same user.

## Newsletter contract

### Request

```ts
type MarketplaceNewsletterPreferencesUpdate = {
  enabled?: boolean;
  countryFilter?: string[] | null;
};
```

Rules:

- Missing `enabled` leaves the current value unchanged.
- Missing `countryFilter` leaves the current filter unchanged.
- `countryFilter: []` clears the filter and stores `null`.
- `countryFilter: null` also clears the filter.
- Country values are trimmed non-empty strings. The existing UI sends display
  strings, not ISO country codes, so the first target contract keeps strings.

### Response

```ts
type MarketplaceNewsletterPreferences = {
  enabled: boolean;
  countryFilter: string[] | null;
};
```

Empty state: if no row exists, return `{ enabled: true, countryFilter: null }`.

### Errors

| Case                           | Status | Code              |
| ------------------------------ | ------ | ----------------- |
| Missing or invalid auth        | `401`  | `unauthenticated` |
| Missing marketplace permission | `403`  | `forbidden`       |
| Invalid body                   | `400`  | `invalid_request` |
| Unexpected failure             | `500`  | `internal_error`  |

## Invite-code admin contract

### Create request

```ts
type MarketplaceInviteCodeCreateRequest = {
  payload: BookingAdminSetupInvitePayload;
};
```

`BookingAdminSetupInvitePayload` is the setup wizard payload currently shaped by
`apps/vayada-admin/services/api/inviteCodes.ts` and consumed by
`apps/booking-admin/app/setup/page.tsx`. It includes these top-level sections:

```ts
type BookingAdminSetupInvitePayload = {
  property?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  rooms?: Array<Record<string, unknown>>;
  addons?: Array<Record<string, unknown>>;
  benefits?: string[];
  policies?: Record<string, unknown>;
  lastMinuteDiscount?: Record<string, unknown>;
  internal?: {
    activePlan?: "commission" | "fixed";
    commissionRate?: number;
    fixedMonthlyFee?: number;
    paymentProvider?: "stripe" | "xendit" | "vayada";
    xenditChannelCode?: string;
    xenditAccountNumber?: string;
    xenditAccountHolderName?: string;
  };
};
```

The implementation may accept the existing snake_case legacy payload during the
compatibility window, but the typed client should expose camelCase fields and
normalize at the API boundary.

### Admin response

```ts
type MarketplaceInviteCodeAdminItem = {
  id: string;
  code: string;
  status: "pending" | "redeemed" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  hotelName: string | null;
  redeemedAt: string | null;
  payloadSummary: {
    paymentProvider: "stripe" | "xendit" | "vayada" | null;
  };
};
```

Admin list ordering: `createdAt DESC`.

Delete behavior: `DELETE` revokes when the target table supports `revoked`;
hard delete is legacy behavior and should not be carried forward unless the
cutover PR documents why audit retention is not required. A revoked code is not
valid for public lookup or redeem.

## Invite-code public contract

### Lookup response

```ts
type MarketplaceInviteCodeLookup = {
  code: string;
  payload: BookingAdminSetupInvitePayload;
};
```

Lookup rules:

- Code input is trimmed and uppercased.
- Pending, unexpired codes return `200`.
- Redeemed, expired, or revoked codes return `410`.
- Unknown codes return `404`.
- Expired pending codes may be marked `expired` as part of the lookup.

### Redeem response

```ts
type MarketplaceInviteCodeRedeem = {
  status: "redeemed";
};
```

Redeem rules:

- Code input is trimmed and uppercased.
- Pending, unexpired codes redeem for the authenticated user.
- Repeating redeem for the same code and same user returns `200` with
  `{ status: "redeemed" }`.
- Redeemed by a different user, expired, or revoked codes return `410`.
- Unknown codes return `404`.

### Errors

| Case                               | Status | Code              |
| ---------------------------------- | ------ | ----------------- |
| Unknown code                       | `404`  | `not_found`       |
| Redeemed, expired, or revoked code | `410`  | `invite_invalid`  |
| Missing auth on redeem             | `401`  | `unauthenticated` |
| Invalid payload or malformed code  | `400`  | `invalid_request` |
| Unexpected failure                 | `500`  | `internal_error`  |

## Cutover requirements

- Add one typed client per consumer app:
  - marketplace-web newsletter preferences;
  - vayada-admin invite-code admin CRUD;
  - booking-admin invite-code lookup/redeem.
- Update booking-admin setup in the same cutover as the public invite-code
  routes. Leaving `apps/booking-admin/app/setup/page.tsx` on raw legacy fetches
  breaks prefilled hotel onboarding when marketplace-api routing changes.
- Keep legacy Python behavior as the production source of truth for these
  surfaces until the TypeScript routes, typed clients, route tests, frontend
  builds, and booking-admin setup smoke are accepted.
- Do not migrate weekly newsletter sending, email delivery, or platform job
  delivery in this slice.

## Validation target for implementation

The implementation PR should include:

- route tests for newsletter get/update, invite admin list/create/revoke,
  invite lookup, and idempotent redeem;
- authorization denial tests for newsletter, invite admin, and redeem;
- frontend build checks for `marketplace-web`, `vayada-admin`, and
  `booking-admin`;
- a booking-admin setup browser smoke that applies an invite code and confirms
  the wizard is prefilled before setup submission.
