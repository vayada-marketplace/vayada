# Next-stack legacy dependency inventory

VAY-880 inventory for the TypeScript rewrite next stack.

This complements:

- [apps-api legacy runtime dependency audit](apps-api-legacy-runtime-dependency-audit.md)
- [booking/PMS route migration inventory](booking-pms-route-migration-inventory.md)
- [marketplace route migration inventory](marketplace-route-migration-inventory.md)
- [RequestContext contract](request-context-contract.md)

> **Retirement update:** The legacy public-profile repository and the public
> profile and Booking settings source selectors are removed from `apps/api`.
> The legacy Booking settings repository and `BOOKING_DATABASE_URL` are also
> removed. Public bookability now directly composes the target quote/calendar
> repositories with no compatibility selector. Booking Web checkout commands
> and lifecycle jobs likewise compose only target adapters.
> Historical entries below describe the earlier VAY-880 state.

> **Note (VAY-2272, 2026-10-20):** the Marketplace, the affiliate program and the creator accounts
> are gone: `next-marketplace` (`apps/marketplace-web`), `next-affiliate`
> (`apps/affiliate-dashboard`), the old Python Marketplace API and their `apps/api` routes are
> deleted (the hotel invite routes kept their `/api/marketplace/...` paths until VAY-2302 moved them to `/api/platform/admin/invite-codes` and `/api/hotel-setup/hotel-account-invites/*`), and migrations 0496-0502 drop their data from the new database.
> Their entries are removed below; their history is in the
> [marketplace route migration inventory](marketplace-route-migration-inventory.md) and
> [affiliate portal source retirement](affiliate-portal-retirement.md).

## Scope

Audited next-stack surfaces:

- `next-api` (`apps/api`)
- `next-pms` (`apps/pms-web`)
- `next-booking-admin` (`apps/booking-admin`)
- `next-booking` (`apps/booking-web`)
- `next-admin` (`apps/vayada-admin`)

Out of scope for this inventory: changing customer-facing normal production
routes, deleting compatibility code, or migrating callers. This document records
what still depends on legacy shapes and what proof is needed before deletion.

## Summary

The next-stack debt falls into four groups:

1. `apps/api` still defaults several source selectors to legacy/disabled modes
   and still reads legacy service URLs/database URLs.
2. Admin frontends still rely on old `/admin/*`, `/super-admin/*`, and direct
   legacy service clients, often scoped by `X-Hotel-Id`.
3. Several compatibility adapters intentionally return fake/no-op data so next
   route smoke can render before target contracts exist.
4. Smoke coverage catches selected migrated routes, but there is no global
   no-legacy-call guard yet, and Booking Admin shell mocks still allow broad
   `/admin/**` traffic.

## Inventory

1. **`next-api`: legacy source defaults and runtime envs**
   - **Old thing:** `apps/api/src/config.ts` still defaults multiple selectors
     to legacy or disabled modes and reads legacy runtime envs:
     `PUBLIC_HOTEL_PROFILE_SOURCE=legacy`, `BOOKING_*_SOURCE=legacy`,
     `PMS_OPERATIONS_SOURCE=disabled`, `FINANCE_SOURCE=legacy`,
     `BOOKING_PUBLIC_API_URL`, `PMS_PUBLIC_API_URL`, `PMS_API_URL`, and the
     now-retired legacy checkout proxy flag (lines 306-468). The concrete legacy product
     runtime envs are `BOOKING_DATABASE_URL`, `BOOKING_PUBLIC_API_URL`,
     `PMS_API_URL`, and `PMS_PUBLIC_API_URL` (lines 424-457).
   - **Current consumer:** all next frontends using target API routes.
   - **Target replacement:** target-schema repositories and source flags set to
     `target`, with legacy product DB/API envs unset for migrated route groups.
   - **Owner domain:** platform plus owning product domains.
   - **Deletion blocker / proof needed:** a repeatable boot/route check proves
     migrated route groups do not instantiate legacy repos or HTTP clients.
   - **Follow-up:** VAY-882 plus VAY-760 follow-ups.

2. **`next-api`: auth compatibility bridge**
   - **Old thing:** `/auth/compat/*-token` routes mint short-lived legacy JWTs
     for Booking Admin and PMS Web (`apps/api/src/routes/authSession.ts`),
     backed by `AUTH_LEGACY_BOOKING_JWT_SECRET` and `AUTH_LEGACY_PMS_JWT_SECRET`
     (`apps/api/src/config.ts`).
   - **Current consumer:** `booking-admin` and `pms-web`.
   - **Target replacement:** AuthKit session plus typed
     `RequestContext`/route-policy authorization; no legacy JWT secret per
     migrated surface.
   - **Owner domain:** WorkOS / Identity.
   - **Deletion blocker / proof needed:** each frontend proves normal flows use
     AuthKit/RequestContext tokens directly and no migrated request calls
     `/auth/compat/*`.
   - **Follow-up:** VAY-878, VAY-883, WorkOS surface cutover tickets.

3. **Cross-surface scope: `X-Hotel-Id`**
   - **Old thing:** `X-Hotel-Id` as routing scope
     (`apps/booking-admin/services/api/client.ts` lines 86-90;
     `apps/pms-web/services/api/client.ts` lines 81-85;
     `apps/vayada-admin/services/api/bookingClient.ts` lines 7-8;
     `apps/api/src/routes/pmsOperations.ts` lines 2100-2119).
   - **Current consumer:** Booking Admin, PMS Web, and Platform Admin booking
     settings calls. The former Ask Intelligence consumer is retired.
   - **Target replacement:** explicit resource ids in typed route paths or
     request bodies, authorized through `RequestContext.linkedResources` and
     route policy.
   - **Owner domain:** platform auth plus product domains.
   - **Deletion blocker / proof needed:** browser smoke and route tests show
     migrated calls no longer send `X-Hotel-Id` as the trust boundary.
   - **Follow-up:** VAY-878, VAY-883, VAY-885, VAY-881.

4. **`next-pms`: direct PMS legacy clients**
   - **Old thing:** direct PMS API client fallback
     `NEXT_PUBLIC_PMS_API_URL || "https://api.pms.localhost"` and handoff
     fallback `https://pms-api.vayada.com`
     (`apps/pms-web/services/api/pmsClient.ts` lines 1-7;
     `apps/pms-web/app/handoff/page.tsx` lines 52-91). PMS Web also calls broad
     legacy admin route families for financials, import, messaging, rooms,
     room-types, module activations, Channex, bookings, calendar, settings,
     payment/Stripe, and room blocks (`apps/pms-web/services/financials/index.ts`
     lines 116-143; `apps/pms-web/services/messaging/index.ts` lines 59-114;
     `apps/pms-web/services/rooms/index.ts` lines 367-417).
   - **Current consumer:** PMS Web setup, settings, calendar, bookings, channel
     manager, rooms, financials, messaging, and handoff.
   - **Target replacement:** typed PMS operations routes for rooms/calendar/
     messaging/operational reservations; finance contracts for invoices,
     payments, payouts, payment settings, and Stripe/Xendit; Channex target
     intake/cutover contracts for channel connectivity.
   - **Owner domain:** PMS operations / finance / platform media / channel
     connectivity.
   - **Deletion blocker / proof needed:** PMS Web smoke records no old PMS host
     and no `/admin/*` helper routes for migrated surfaces.
   - **Follow-up:** VAY-878 for next-stack PMS helper migration; VAY-770 and
     implementation slices VAY-775-VAY-784 for PMS operations; VAY-795 and
     VAY-810-VAY-815 for finance; VAY-806 and VAY-820-VAY-827 for platform
     media/import; VAY-772 and VAY-785-VAY-794 for Channex/webhooks.

5. **`next-api`: PMS legacy admin adapters**
   - **Old thing:** `registerPmsLegacyAdminRoutes` registers PMS-shaped
     `/admin/*` helpers and fake/no-op values for unread count, payment
     settings, Channex status/channels, and calendar settings
     (`apps/api/src/routes/pmsOperations.ts` lines 1775-2098).
   - **Current consumer:** PMS Web while it still calls admin-shaped endpoints.
   - **Target replacement:** typed `/api/pms/properties/:propertyId/*`
     read/command contracts.
   - **Owner domain:** PMS operations / finance / channel connectivity.
   - **Deletion blocker / proof needed:** PMS Web migrates first; API tests
     prove typed routes still cover the real contracts.
   - **Follow-up:** VAY-879 after VAY-878.

6. **`next-booking-admin`: backend helper facade**
   - **Old thing:** `bookingAdminCompat` registers Booking Admin `/admin/*`
     helpers with zeroed dashboards, empty modules/add-ons/promo codes, fake
     custom-domain status, and 501 writes
     (`apps/api/src/routes/bookingAdminCompat.ts` lines 71-258).
   - **Current consumer:** Booking Admin dashboard, design/settings, modules,
     custom domain, add-ons, promo codes, setup.
   - **Target replacement:** typed Booking settings, dashboard/read-model, hotel
     catalog, domain verification, and finance contracts.
   - **Owner domain:** Booking / finance / platform events.
   - **Deletion blocker / proof needed:** Booking Admin no longer calls these
     helper paths, and unavailable features render explicit disabled states
     instead of fake success.
   - **Follow-up:** VAY-883, then VAY-884.

7. **`next-booking-admin`: settings and setup calls**
   - **Old thing:** Booking Admin service still calls old `/admin/hotels`,
     `/admin/superadmin/hotels`, `/admin/settings/property`,
     `/admin/settings/setup-status`, `/admin/addons`, `/admin/promo-codes`, and
     custom-domain paths (`apps/booking-admin/services/settings/index.ts` lines
     240-348). Setup wizard posts PMS `/admin/register-hotel`,
     `/admin/room-types`, `/admin/payment-settings`, and `/admin/hotel`
     (`apps/booking-admin/app/setup/page.tsx` lines 366-480).
   - **Current consumer:** Booking Admin setup, settings, design studio, booking
     flow.
   - **Target replacement:** typed Booking setup/catalog/settings contracts, PMS
     room setup contracts, and finance payment-setting contracts.
   - **Owner domain:** Booking / PMS operations / finance.
   - **Deletion blocker / proof needed:** saves persist through target routes or
     fail visibly; target gaps are linked instead of hidden behind helper
     facades.
   - **Follow-up:** VAY-883; missing domain contracts should become owner
     tickets if VAY-883 cannot implement them.

8. **`next-booking-admin`: direct PMS service client**
   - **Old thing:** Booking Admin has its own direct PMS service client
     `NEXT_PUBLIC_PMS_URL || "https://api.pms.localhost"`
     (`apps/booking-admin/services/api/pmsClient.ts` lines 1-8). It backs
     module activations, setup PMS registration/room creation, payment
     settings, Stripe onboarding, and room-type lookups
     (`apps/booking-admin/services/api/moduleActivationClient.ts` lines 34-45;
     `apps/booking-admin/app/setup/page.tsx` lines 392-480;
     `apps/booking-admin/app/(app)/settings/page.tsx` lines 279-299 and
     495-496).
   - **Current consumer:** Booking Admin feature modules, setup wizard,
     settings payment/Stripe sections, and room lookup helpers.
   - **Target replacement:** typed Booking Admin/settings contracts for modules
     and setup state, typed PMS operations contracts for rooms and PMS setup,
     and finance contracts for payment/Stripe behavior.
   - **Owner domain:** Booking / PMS operations / finance.
   - **Deletion blocker / proof needed:** Booking Admin smoke records no
     `NEXT_PUBLIC_PMS_URL` old-host fallback and no PMS `/admin/*` calls for
     migrated Booking Admin surfaces; payment gaps are linked to their domain
     owner tickets.
   - **Follow-up:** VAY-883 for Booking Admin helper migration and
     VAY-770/VAY-795 for PMS/finance contracts.

9. **Retired: `next-booking-admin` Ask Intelligence scope header**
   - **Old thing:** Ask client sends `X-Hotel-Id` while also sending
     organization scope (`apps/booking-admin/services/api/askIntelligenceClient.ts`
     lines 71-85).
   - **Current state:** Removed with the Booking Admin panel, Ask client, and Ask
     API runtime. There is no current consumer.
   - **Target replacement:** None. The future hotel employee agent requires a
     new architecture from VAY-1091.
   - **Owner domain:** None; the former Ask Intelligence domain is retired.
   - **Deletion proof:** The frontend client and route are deleted, and the
     legacy-call surface no longer registers Booking Admin Ask.
   - **Follow-up:** VAY-887 is superseded by retirement; use VAY-1091 for future
     agent scope and authorization design.

10. **`next-booking`: public API base fallback**

- **Old thing:** Booking Web public client defaults to
  `NEXT_PUBLIC_BOOKING_WEB_API_URL || "https://api.localhost"`
  (`apps/booking-web/services/api/client.ts` lines 81-85;
  `apps/booking-web/lib/server/publicHotelMetadata.ts` lines 72-78).
- **Current consumer:** Booking Web public hotel pages and metadata.
- **Target replacement:** explicit next-api public Booking Web base URL per
  environment.
- **Owner domain:** Booking Web / platform runtime config.
- **Deletion blocker / proof needed:** smoke records no legacy host fallback;
  production/staging envs pin next-api.
- **Follow-up:** VAY-881, VAY-882.

11. **`next-api`: Booking Web public compatibility adapter**
    - **Old thing:** checkout/status/lookup/guest command routes proxy to
      `PMS_PUBLIC_API_URL`; promo/domain use `BOOKING_PUBLIC_API_URL`
      (`apps/api/src/routes/bookingWebPublic.ts` lines 1305-1457 and
      2368-2423).
    - **Current consumer:** Booking Web checkout, promo validation,
      custom-domain resolution, and guest lifecycle.
    - **Target replacement:** Booking checkout command handlers, target public
      bookability/domain projections, and target finance ownership.
    - **Owner domain:** Booking / PMS handoff / finance.
    - **Deletion blocker / proof needed:** parity passes with
      `PMS_PUBLIC_API_URL` and `BOOKING_PUBLIC_API_URL` absent.
    - **Follow-up:** VAY-760 follow-ups: VAY-764, VAY-767, VAY-771.

12. **`next-admin`: direct legacy service clients**
    - **Old thing:** Platform Admin still has direct old service clients:
      `NEXT_PUBLIC_PMS_API_URL || "https://pms-api.vayada.com"` and
      `NEXT_PUBLIC_BOOKING_API_URL || "https://booking-api.vayada.com"`
      (`apps/vayada-admin/services/api/pmsClient.ts` lines 1-5;
      `apps/vayada-admin/services/api/bookingClient.ts` lines 1-8).
    - **Current consumer:** Platform Admin KPI/property actions and Booking
      settings admin.
    - **Target replacement:** typed `next-api` platform-admin, booking-admin,
      and finance clients.
    - **Owner domain:** platform / booking / finance.
    - **Deletion blocker / proof needed:** browser smoke proves `next-admin` no
      longer calls old service hostnames for migrated surfaces.
    - **Follow-up:** VAY-885.

13. **`next-admin`: old admin route shapes**
    - **Old thing:** Platform Admin still calls Booking `/admin/superadmin/*`,
      `/admin/settings/*`, `/admin/addons`, and `/admin/promo-codes`
      (`apps/vayada-admin/services/booking/settingsService.ts` lines 112-188).
    - **Current consumer:** Platform Admin hotel and finance administration.
    - **Target replacement:** platform admin contracts and explicit platform
      permissions.
    - **Owner domain:** platform / finance.
    - **Deletion blocker / proof needed:** migrated admin flows no longer use
      `/admin/*` or `/super-admin/*`; any missing target contract is linked to
      an owner.
    - **Follow-up:** VAY-885, VAY-795.

14. **Smoke/proof layer: broad admin mocks**
    - **Old thing:** shared Booking Admin mocks still fulfill broad
      `**/admin/**`, while focused tests assert only selected migrated routes
      (`tests/e2e/support/bookingAdminMocks.ts` lines 123-161).
    - **Current consumer:** E2E smoke for next frontends.
    - **Target replacement:** data-driven no-legacy-call guard per migrated
      surface.
    - **Owner domain:** DX / platform verification.
    - **Deletion blocker / proof needed:** guard fails with the offending request
      URL/method when a migrated surface calls banned hosts, route shapes,
      headers, or compatibility endpoints.
    - **Follow-up:** VAY-881.

## Follow-up owner map

- VAY-878: migrate PMS Web off PMS `/admin/*` helper calls and `X-Hotel-Id`.
- VAY-879: delete PMS legacy admin adapters after VAY-878 proves no callers remain.
- VAY-881: add the no-legacy-call smoke guard.
- VAY-882: prove migrated `next-api` route groups boot/serve without legacy
  runtime envs.
- VAY-883: migrate Booking Admin off helper facades/fake data.
- VAY-884: delete Booking Admin helper shims after VAY-883.
- VAY-885: migrate Platform Admin off direct legacy service clients.
- VAY-887 is superseded by Ask Intelligence retirement; VAY-1091 owns future
  hotel employee agent scope and authorization design.
- VAY-770, VAY-795, VAY-806, and VAY-772: owner tracks for PMS operations,
  finance, platform media/import, and Channex/webhook route families surfaced by
  PMS Web.
- VAY-760 follow-ups: Booking Web public profile/domain/bookability/checkout
  runtime dependency removal.

## Cutover validation notes

VAY-882 adds the repeatable `next-api` legacy-free runtime check:

```bash
npm --workspace vayada-api run test:legacy-free
```

The check loads `next-api` with target source flags and no legacy product DB/API
env vars, boots the route app, and serves these migrated public route groups:

- `/api/ai/hotels/*`
- `/api/booking-web/hosts/*`
- `/api/booking-web/hotels/*`

It fails with a `VAY-882 legacy runtime HTTP client called` error if those
covered routes try to call a legacy service client.

Remaining legacy-runtime env requirements outside the covered route groups:

| Env requirement                  | Remaining surface / retirement condition                           | Owner ticket             | Forbidden by `test:legacy-free` |
| -------------------------------- | ------------------------------------------------------------------ | ------------------------ | ------------------------------- |
| Removed: `BOOKING_DATABASE_URL`  | Legacy profile/settings adapters removed                           | VAY-760, VAY-883         | Yes                             |
| `BOOKING_PUBLIC_API_URL`         | Public domain/promo and Booking Admin helper fallbacks removed     | VAY-760, VAY-883         | Yes                             |
| `PMS_API_URL`                    | PMS guest-form sync and Booking Admin/PMS helper fallbacks removed | VAY-878, VAY-883         | Yes                             |
| `PMS_PUBLIC_API_URL`             | Public checkout/status/lookup proxy fallbacks removed              | VAY-760 follow-up tracks | Yes                             |
| `AUTH_LEGACY_BOOKING_JWT_SECRET` | Booking Admin no longer needs legacy Booking JWT handoff           | VAY-883, then VAY-884    | No                              |
| `AUTH_LEGACY_PMS_JWT_SECRET`     | PMS Web no longer needs legacy PMS JWT handoff                     | VAY-878, then VAY-879    | No                              |
