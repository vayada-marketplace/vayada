# Pricing on the ordinary API login (VAY-2057)

_Spike recommendation, 2026-10-07, main `702f777c6`. Read-only investigation;
nothing here grants, deploys, merges or activates anything. Evidence:
`~/.local/share/vayada-testing/evidence/vay2057-pricing-plan-20261007/`
(`inventory-api.md`, `migrations-and-rls.md`, `platform-apparatus.md`,
`open-pricing-prs.md`, `vay1543-comments-export.md`)._

## 0. Decision

2026-10-07, Flamur: "yes proceed". Pricing writes rely on application-level
tenant isolation (the VAY-2054 posture) instead of per-hotel database logins;
the private pricing command service is not built. Slice A starts first.

## 1. Recommendation in one paragraph

Run every pricing operation of the public TypeScript API as
`vayada_next_api_runtime` on `TARGET_DATABASE_URL`, the posture VAY-2054 gives
that login. Nothing in the pricing code needs a second login: the editor,
drafts, publication, terms, FX, charge declarations, quote acceptance and the
accepted-reservation worker already run on it today. Only three call paths
were moved to a separate `PRICING_DATABASE_URL` pool in September (authority
GET/PUT, public offers, quote issue) and they return 503 in production because
that pool was never provisioned. Move them back, delete the private pricing
command service and its role model, remove four `booking.pricing_*` relations
from the VAY-2054 protected list with two narrowings, and then finish prices
end to end in four product slices: PMS manual-booking preview and rate plans,
onboarding pricing step, public offers and quotes on booking-web, Channex.
Tenant isolation stays where VAY-2054 put it for every other product table:
application SQL plus the existing in-transaction authority re-checks, which
are kept unchanged.

## 2. Inventory

Full tables with line numbers are in `inventory-api.md` and
`migrations-and-rls.md`. Summary:

| Area (tickets)                                          | Code                                                                                                                                                                        | Tests                                                                 | Public route                                                          | Login today                       | Blocked by                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (VAY-1539/1554/1555/1556)                     | `engineering/replacement-pricing-contract.md` + fixtures                                                                                                                    | acceptance vectors in unit tests                                      | —                                                                     | —                                 | nothing; accepted by implementation                                                                                              |
| Storage (VAY-1540/1557/1558)                            | migrations 0300–0311 on main; `replacementPricingStore.ts`, `replacementPricingSnapshot.ts`                                                                                 | integration (325, 221) + `backend-migration` storage test             | —                                                                     | ordinary                          | nothing                                                                                                                          |
| Authority store (VAY-1543)                              | `bookingPricingAuthority.ts`                                                                                                                                                | integration (885)                                                     | GET/PUT `/pricing-v2/authority`                                       | **pricing pool**                  | credential plumbing only                                                                                                         |
| Public offers (VAY-1543)                                | `publicPricingOfferCatalog.ts` + `publicPricing*.ts`                                                                                                                        | unit + owners integration                                             | GET `/hotels/:slug/pricing-offers`                                    | **pricing pool**                  | credential plumbing only                                                                                                         |
| Quote issue (VAY-1543)                                  | `currentPricingQuote*.ts`, `routes/replacementBookingQuote.ts`                                                                                                              | unit + owners integration                                             | POST `/hotels/:slug/bookings/quote`                                   | **pricing pool**                  | credential plumbing only                                                                                                         |
| Quote acceptance (VAY-1543)                             | `preparePricingAcceptance`, `storePricingAcceptance`, `pricingAcceptanceWriter`, lifecycle/revenue/draft                                                                    | 10 unit + 8 `.postgres` (2.3k lines)                                  | POST `.../quotes/:id/accept`                                          | ordinary                          | slug allowlist (`REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS`)                                                                  |
| Editor commands (VAY-1936/1938/1939/1941)               | `replacementPricingCommands.ts`, `routes/replacementPricing.ts`, pms-web `components/pricing/*`                                                                             | unit + integration (355)                                              | `/pricing-v2*`                                                        | ordinary                          | nothing server-side; browser acceptance pending                                                                                  |
| Draft workflow and editors (VAY-1944–1999 frontend)     | pms-web `PricingEditor.tsx`, Months/Seasons/Weekdays/Dates/ChildCharges/MealCharges/StayRules/LinkedOffer/StayPreview                                                       | vitest per component                                                  | `/pricing-v2*`                                                        | ordinary                          | browser acceptance; draft **terms** editing (VAY-1996/1997/1998) not implemented (`routes/replacementPricing.ts:81` returns 403) |
| Calendar occupancy (VAY-1990)                           | `PricingStayPreview`, `domain-pms/replacementPricingCalculator.ts`                                                                                                          | unit; no real-storage evidence                                        | —                                                                     | ordinary                          | evidence only                                                                                                                    |
| FX (VAY-1925/1926/1927/1878)                            | `replacementPricingFx.ts`, `replacementPricingFxStore.ts`                                                                                                                   | unit (99) + integration (88)                                          | via publish                                                           | ordinary                          | nothing                                                                                                                          |
| Terms (VAY-1561/1940)                                   | `bookingPricingOfferTerms.ts`, pms-web `PricingTerms.tsx`                                                                                                                   | integration (208)                                                     | `/pricing-v2/.../terms`                                               | ordinary                          | nothing                                                                                                                          |
| Mandatory charges (VAY-1667)                            | `pmsMandatoryChargePricingSourceSnapshot.ts`                                                                                                                                | unit + 3 integration                                                  | `/mandatory-charge-confirmation`                                      | ordinary                          | nothing                                                                                                                          |
| Manual-booking preview (VAY-1422/647)                   | `routes/pmsManualBookingPreviewCalculation.ts` **stub** (`:80`), `pmsManualBookingTransactionalPricing.ts`                                                                  | route unit, `pricingReset.test.ts`                                    | POST `.../manual-bookings/preview`, POST `.../manual-bookings`        | ordinary                          | **missing logic** (deleted in VAY-1546)                                                                                          |
| Legacy flexible-rate / recurring routes                 | `pmsPricingCommandRepository.ts:349`, `pmsPricingReadModel.ts:133-145`, `pmsRecurringPricingCommandRepository.ts:30-45` **stubs**                                           | unit                                                                  | `flexible-rate-plan`, `pricing-source/recurring*`                     | ordinary                          | **retired model**; readers must be re-based on the publication                                                                   |
| Room create/duplicate/move (VAY-1546 leftovers)         | `pmsOperationsCommandRepository.ts:373, 517, 6287` **stubs**                                                                                                                | unit + integration                                                    | POST `room-types`, `.../duplicate`, move `target_base`                | ordinary                          | missing logic (embedded rate seeding)                                                                                            |
| Channex consumption (VAY-1952/1953/1954/1956/1967/1970) | `channexPricingPropertyAuthority.ts`, `readPublishedPricingForChannexJob`, `channexPublishedOfferCreate.ts`, `channexNightlyPrices.ts`, `channexPublishedOfferBootstrap.ts` | integration (252, 216, 7763 incl. CI `-t "restricted Channex login"`) | worker only                                                           | **Channex worker login** (proven) | `channexManagementPlans.ts:242-262` provisioning/ARI plan stubs, `pmsChannelDatePrices.ts` stub; VAY-2030 activation             |
| Old booking-web public flow                             | `aiHotelQuotes.ts:108`, `bookingWebMixedQuote.ts:40`, `bookingWebPublic.ts:1214/2865/2897/2948`, `domain-booking` stubs                                                     | `pricingReset.test.ts`                                                | `/hotels/:slug/offers`, `/calendar`, POST `/bookings`, change preview | ordinary                          | retired model; superseded by `/pricing-offers` + quote + accept                                                                  |

Facts that change the brief:

- **Platform PR #344 is merged** (2026-10-04, `1c31ac6`), not draft; all of its
  content is default-off source. **#417 is open and not approved.** Two
  pricing security groups (9 resources) are live in AWS state.
- There is no `vayada_next_pricing_*` role in any migration; the roles exist
  only in tests, the proof script and the private service's config checks.
- Every pricing RLS policy (0409/0421/0422/0429/0430/0434/0435) keys on the
  `^vayada_next_pricing_` name prefix. `vayada_next_api_runtime` passes all of
  them, so they are inert for the ordinary login.
- There is no `SECURITY DEFINER` function in the pricing area.
- The native PG16/17 pricing tests exist (17 integration + 8 `.postgres`
  files) but CI runs only two of them; the rest run locally against
  `TEST_DATABASE_URL`.

## 3. Architecture under `vayada_next_api_runtime`

### 3.1 Flows

All flows keep one caller-owned `READ COMMITTED` transaction, the existing lock
order (inventory advisory lock → organization lock → row locks) and the
existing in-transaction re-checks. Only the pool changes.

| Flow                                                                   | Today                                                                                                                               | After                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority GET/PUT (`routes/replacementPricing.ts:73-80`)               | `createReplacementPricingCommands(propertySetupOwnerPool, ctx, pricingRuntimePool)`; authority store on the 3rd pool; 503 if absent | `createReplacementPricingCommands(propertySetupOwnerPool, ctx)`; the authority store opens its transaction on the same pool. `lockReplacementPricingAuthorization` (membership, assignment, permission overrides, resource link, entitlement, suspension) and `lockBookingPricingAuthority` (head/revision `FOR SHARE`) run unchanged inside that transaction; CAS on `expectedRevision` and idempotent replay by `request_id` unchanged |
| Public offers (`bookingWebPublic.ts:566-575`)                          | `createPublicPricingOfferCatalog(config.pricingPool)`                                                                               | `createPublicPricingOfferCatalog(pool)` where `pool` is the adapter's existing target pool (`:1493-1499`). Slug → property is resolved server-side under `lockPublicPricingAuthority` + `lockCurrentPricingPublication`; the request carries only the slug                                                                                                                                                                               |
| Quote issue (`:710-732`)                                               | `createCurrentPricingQuoteStore(config.pricingPool, 300)`                                                                           | same store on the target pool. Property and organization of the inserted `booking.pricing_quotes` row come from the locked publication, never from the body; the row is append-only by trigger                                                                                                                                                                                                                                           |
| Quote accept, addons, disclosure                                       | target pool (already)                                                                                                               | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PMS manual-booking preview and create                                  | stub                                                                                                                                | computed inside the caller's transaction from the active `pms.pricing_v2_heads` publication (see slice A)                                                                                                                                                                                                                                                                                                                                |
| Pricing editor commands (`/pricing-v2*`)                               | ordinary                                                                                                                            | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Channex reads                                                          | Channex worker login (`channexUploadReconciliationPool`)                                                                            | unchanged; the ordinary API only publishes                                                                                                                                                                                                                                                                                                                                                                                               |
| Private pricing command service (`pricingCommandServer.ts`, port 8010) | exists, never deployed                                                                                                              | deleted                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Fail-closed behaviour is preserved: a publication that is stale, unpublished,
moved slug, owner mismatch or missing authority still returns unavailable.
What disappears is the artificial 503 caused by a missing second pool.

### 3.2 Per-table posture

VAY-2054 (`design.md`, protected list) currently keeps
`booking.pricing_authority_heads`, `booking.pricing_authority_revisions`,
`booking.pricing_quotes` and the `booking.pricing_runtime_effective_*` views
write-protected "reserved for the pricing command service". This plan changes
that as follows; every other pricing relation is already ordinary DML in the
VAY-2054 default and stays so.

| Relation                                                                                                                                                                                                                                                                                                                                 | Posture after VAY-2057                                                                                            | Mechanism                                                                                                                                 | Why it is safe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booking.pricing_authority_revisions`                                                                                                                                                                                                                                                                                                    | `SELECT, INSERT, UPDATE` (narrowing: no `DELETE`)                                                                 | VAY-2054 narrowing table + existing `pricing_authority_revisions_immutable` trigger (0306:20-21) which blocks real UPDATE/DELETE/TRUNCATE | the `UPDATE` grant is needed only because `lockBookingPricingAuthority` runs `... FOR SHARE OF h,r` on heads **and revisions** (`bookingPricingAuthority.ts:32-34`); PostgreSQL requires `UPDATE` on a locked relation, and the VAY-2054 append-only narrowing (`has_any_column_privilege(...,'UPDATE')`) would make that lock fail with 42501. A real `UPDATE` is still rejected by the trigger, which the ordinary login cannot disable (no DDL, not owner, not superuser). History stays append-only                                                                                                                            |
| `booking.pricing_authority_heads`                                                                                                                                                                                                                                                                                                        | `SELECT, INSERT, UPDATE` (narrowing: no `DELETE`)                                                                 | VAY-2054 narrowing                                                                                                                        | the only mutable row is the CAS pointer; its composite FK `(property_id, revision) → revisions` (0306:17-18) plus `revision UNIQUE` (0306:4) make a head point only at a revision of the same property, so cross-property reparenting fails by constraint regardless of login. The revision's `organization_id` is only FK'd to `identity.organizations` (0306:6); the organization binding is application-enforced by `lockReplacementPricingAuthorization` before the write and re-checked fail-closed by every reader (`publicPricingAuthority.ts:54-65`, `currentPricingPublication.ts:131-144`)                               |
| `booking.pricing_quotes`                                                                                                                                                                                                                                                                                                                 | `SELECT, INSERT` (narrowing: no `UPDATE`/`DELETE`)                                                                | narrowing + append-only trigger (0309)                                                                                                    | no code path row-locks quotes (all reads are plain `SELECT`: `currentPricingQuoteStore.ts:88,162`, `currentQuoteRevalidation.ts:40`, `currentQuotePromoRedemption.ts:48`, `currentQuoteInventory.ts:58`, `pricingBookingDraft.ts:49`; `pricingAcceptanceReplay.ts:41-45` locks `FOR SHARE OF r` only), so the strict narrowing is safe. A future `FOR SHARE` on quotes needs the posture changed first; keep a negative test. A quote is evidence, not authority: acceptance re-locks publication, inventory and terms (`preparePricingAcceptance`); the table CHECK binds `payload.quote.stay.propertyId = property_id` (0309:11) |
| `booking.pricing_quote_acceptances`                                                                                                                                                                                                                                                                                                      | ordinary DML as today (append-only trigger, `require_pricing_acceptance_quote` BEFORE INSERT)                     | default                                                                                                                                   | unchanged; already written by the ordinary login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pms.pricing_v2_heads/_revisions/_rooms/_drafts`, `pms.pricing_v2_charge_declarations`, `booking.pricing_v2_offer_terms/_heads/_candidates`, `finance.pricing_v2_fx_observations`, `booking.fixed_charge_*`, `booking.room_last_minute_*`, `booking.guest_choice_*`, `pms.property_pricing_settings`, `pms.rate_plans`, `pms.rate_rules` | ordinary DML (VAY-2054 default)                                                                                   | default privileges                                                                                                                        | already the case; immutability where it matters is trigger-based (`pms.pricing_v2_immutable`, append-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `booking.pricing_runtime_effective_property_scopes`, `_authority_scopes` (views)                                                                                                                                                                                                                                                         | read-only until dropped                                                                                           | keep in protected list until slice E drops them                                                                                           | only the deleted private service reads them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `platform.pricing_runtime_property_scopes`                                                                                                                                                                                                                                                                                               | read-protected until dropped                                                                                      | keep in protected list until slice E                                                                                                      | owner-managed scope table for logins that will no longer exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lock targets outside pricing (identity, `hotel_catalog`, `distribution`, `finance`, `pms.room_types`)                                                                                                                                                                                                                                    | as VAY-2054 decides: ordinary DML on product schemas; lock-only `UPDATE (id)` on the six identity tables via 0475 | VAY-2054                                                                                                                                  | the pricing paths lock exactly the relations VAY-2054 already enumerated (`pricing-runtime-role-boundary.md:55-85` ⊂ the 164 locked relations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SECURITY DEFINER`                                                                                                                                                                                                                                                                                                                       | none for pricing                                                                                                  | —                                                                                                                                         | pricing has no definer functions; VAY-2056's definer-execute exception is not needed here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The security argument, stated plainly: under VAY-2054 the ordinary login can
already write `pms.pricing_v2_heads`, i.e. the prices themselves, and every
other product table, with tenant isolation enforced by application SQL. Keeping
the authority pointer and the quote ledger behind a separate credential while
the price source is writable protects nothing the attacker would want. The
immutability that matters (revision history, quotes, acceptances) is enforced
by `platform.prevent_append_only_mutation()` triggers (0010:60-68) on 0306,
0309 and 0311; they are default `ENABLE` (not `ENABLE ALWAYS`), so only a
superuser or the table owner with DDL could bypass them, and the ordinary
login is neither (slice E may add `ENABLE ALWAYS`). The property-scope RLS of
0409 was designed for per-property logins; with one login it cannot express
anything the FK and the application checks do not already express. The only
genuinely new real-`UPDATE` target for the ordinary login is
`pricing_authority_heads`; it already has real `UPDATE` on
`pms.pricing_v2_heads` (`replacementPricingStore.ts:116`) and
`booking.pricing_v2_offer_term_heads` (`bookingPricingOfferTerms.ts:109-117`)
under VAY-2054.

### 3.3 Redundant policies

Migrations 0409 (scope table, views, three policy sets), 0421, 0422, 0429,
0430, 0434, 0435 only constrain `^vayada_next_pricing_` logins. With no such
login they are dead code but harmless. Recommendation:

- Phase 1 (slices 0–D): leave them in place. They cost nothing and dropping
  them changes catalog text that four runtime boundary checks pin by hash
  (`jobs/financeExpenseWorkerBoundary.ts:11-14`,
  `hotelSetupCreationPrivileges.ts:274-277`,
  `hotelSetupLaunchSettingsPrivileges.ts:101-104`,
  `domains/affiliateCaptureRoleBoundary.ts:284-305`) and platform hotel-setup
  scripts pin the Channex scope helpers.
- Phase 2 (slice E, after the ordinary path is verified in production): one
  migration drops the 0409 views, the scope table and the seven pricing-only
  policy sets; the same PR recomputes the pinned digests from a freshly
  migrated database and updates everything that enumerates the 0409 objects:
  `jobs/channexManagementWorkerBoundary.ts:19-20`,
  `jobs/financeExportWorkerBoundary.ts:125`, the privilege matrices in
  `hotelSetupCreationPrivileges.ts:137-140` and
  `hotelSetupLaunchSettingsPrivileges.ts:47-50`, and the tests
  `jobs/financeExpenseWorkerBoundary.integration.test.ts:62-117`,
  `jobs/financeExportWorkerBoundary.integration.test.ts:136`,
  `jobs/channexManagementWorkerBoundary.integration.test.ts:185-186`,
  `hotelSetupLaunchSettingsScope.integration.test.ts:134-138`,
  `packages/backend-migration/src/cli/legacyHistoricalBindingProductionPreflight.integration.test.ts:116-119`.
  0408 (Channex worker) stays.
- Never grant `vayada_next_api_runtime` membership in a `vayada_next_pricing_*`
  role: the policies' pass-through disjunct is `session_user !~ '^vayada_next_pricing_'
AND current_user !~ ... AND NOT EXISTS (pg_has_role ...)`, so membership
  would flip it and the restrictive policies would deny its writes. No such
  role exists in any migration, and the VAY-2054 preflight asserts zero role
  memberships.

### 3.4 Deletion list

App repo (`vayada`):

| Delete                                                                                                                                                                                                                                                                                                                                                                           | Why                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/api/src/server.ts:501-507` `pricingRuntimePool`, `:524` `pricingPool`, `:1815` third argument, `:2455` shutdown                                                                                                                                                                                                                                                            | single login                                                                             |
| `apps/api/src/config.ts:174, 1024, 1055-1070, 1304` `pricingDatabaseUrl` and the distinct-user check; `config.test.ts:61-90` and the `PRICING_DATABASE_URL` case in `:118-135`                                                                                                                                                                                                   | no second URL (it is set nowhere: not in `.env.example`, not in platform `infra/ecs.tf`) |
| `apps/api/src/pricingCommandServer.ts`, `pricingCommandService.ts`, `pricingCommandServiceConfig.ts` + 3 tests (≈1.2k lines); `apps/api/package.json:17` `start:pricing-command`; `pr-checks.yml:421-426` step                                                                                                                                                                   | private service                                                                          |
| `assertRuntimeScope` hooks in `bookingPricingAuthority.ts:45-62,103`, `publicPricingOfferCatalog.ts:13-31`, `currentPricingQuoteStore.ts:39-77,151`; tests `bookingPricingAuthorityRuntimeScope.test.ts`, `publicPricingRuntimeScope.test.ts`, `routes/bookingWebPricingPool.test.ts`; "fails closed without a dedicated authority pool" in `replacementPricingCommands.test.ts` | role-scope apparatus                                                                     |
| `scripts/pricing-property-boundary-proof.py` (835)                                                                                                                                                                                                                                                                                                                               | per-property login proof                                                                 |
| `engineering/pricing-command-service-contract.md`, `pricing-runtime-role-boundary.md`, `pricing-property-boundary-proof.md`                                                                                                                                                                                                                                                      | superseded by this document (keep as history or move under `engineering/archive/`)       |
| Slice E migration: 0409 views + scope table + policies of 0409/0421/0422/0429/0430/0434/0435                                                                                                                                                                                                                                                                                     | redundant                                                                                |

Platform repo (`vayada-platform`), see `platform-apparatus.md`:

| Delete / change                                                                                                                                                                                                                                                                                                                             | Note                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `.github/workflows/pricing-command-bootstrap-plan.yml`, `pricing-verification-reader.yml`                                                                                                                                                                                                                                                   | manual-only; the reader cannot run today            |
| `infra/pricing_command_secrets.tf`, `pricing_command_metadata_policy.json.tftpl`, `infra/pricing-bootstrap-identity/*`, `deployment/pricing-writer-hold.json`, `deployment/pricing-operator-*.tftpl`, `scripts/assert-pricing-bootstrap-plan.py`, `scripts/pricing_bootstrap_approval.py`, `scripts/test_pricing_*.py`, `docs/pricing-*.md` | all default-off; #344 content                       |
| `infra/pricing_command_security_groups.tf`                                                                                                                                                                                                                                                                                                  | **9 live resources**; needs a reviewed destroy plan |
| hooks in `infra/platform_writer_boundary.tf`, `.github/workflows/tf-validate.yml`, `.gitignore`                                                                                                                                                                                                                                             | edit                                                |
| PR #417 close unmerged; draft #251 close; GitHub environment `vay1543-pricing-verification` delete                                                                                                                                                                                                                                          | human action                                        |
| `scripts/target-database-runtime-preflight.mjs` + `grant-target-database-runtime-product-dml.mjs` `noWrite` (VAY-2054 branch L22-33): remove the four `booking.pricing_*` entries, add the three narrowings of §3.2; keep the scope table and views until slice E                                                                           | VAY-2054 follow-up (slice 0.3)                      |
| `scripts/grant-target-database-identity-runtime.mjs:35-36`, `docs/environments.md:301-303,424`                                                                                                                                                                                                                                              | dead after slice E                                  |

Keep: `REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS` (`infra/ecs.tf:323`,
`config.ts:1337`) as the rollout gate for slice C, removed when the first real
hotel is accepted.

## 4. Sliced plan

Order chosen so that every slice leaves prices more usable than before and the
first production-visible win (PMS staff can price a manual booking) does not
wait for the VAY-2054 grant. Each PR ≤ ~400 non-generated lines, stacked where
noted, native PG16/17 tests run locally with `TEST_DATABASE_URL` (migrated via
`npm --workspace @vayada/backend-migration run target:migrate -- --env local`)
and in the `api_postgres` CI job where listed. Estimates are engineer-days for
one agent plus review.

### Slice 0 — single login (prerequisite for C; independent of VAY-2054 grant)

- **0.1 app** Remove `pricingRuntimePool`/`pricingDatabaseUrl`; pass the target
  pool to the offer catalog, quote store and authority store; delete
  `assertRuntimeScope` hooks and the three runtime-scope tests; rewrite
  `bookingWebPricingPool.test.ts` into "offers and quotes use the checkout
  pool". Files: `server.ts`, `config.ts` (+test), `routes/bookingWebPublic.ts`,
  `domains/replacementPricingCommands.ts` (+test), `bookingPricingAuthority.ts`,
  `publicPricingOfferCatalog.ts`, `currentPricingQuoteStore.ts`. Tests that
  encode the old boundary and must be deleted or edited, not just re-run:
  `replacementPricingCommands.integration.test.ts:77-95` ("uses only the
  explicit authority pool") and its third-argument calls (`:56, 84, 181, 186,
240, 346`); `replacementPricingOfferOwners.integration.test.ts:5936, 6908`
  (pass `pricingPool` to the checkout adapter config, a TS excess-property
  error once the field goes); `config.test.ts:61-90, 118-135`. ~300 lines,
  net negative. Tests to run: `replacementPricingCommands.integration`,
  `bookingPricingAuthority.integration`, `replacementPricingOfferOwners.integration`
  (public offers/quote cases) on PG16/17. **1 day.**
- **0.2 app** Delete the private service (`pricingCommandServer.ts`,
  `pricingCommandService.ts`, `pricingCommandServiceConfig.ts`, tests, npm
  script, CI step, proof script). ~1.3k lines deleted, ~0 added. **0.5 day.**
- **0.3 platform (VAY-2054 follow-up)** In `target-database-runtime-preflight.mjs`
  and `grant-target-database-runtime-product-dml.mjs` drop the four
  `booking.pricing_*` entries from `noWrite`, add narrowings
  (`pricing_authority_revisions`: no DELETE; `pricing_authority_heads`: no
  DELETE; `pricing_quotes`: no UPDATE/DELETE), keep the scope table and the two
  views protected; update `test-target-database-runtime-preflight.py:89-91`,
  `test-target-database-runtime-runner.py:302` and the integration shell
  (`test-target-database-runtime-preflight-integration.sh:725` expects an
  UPDATE on heads to be denied → expect DELETE denied and the `FOR SHARE OF
h,r` lock to succeed). ~120 lines. **0.5 day.** **Production step:** the
  grant mode applies the grant set and the protected-list revokes in one
  transaction, so if the VAY-2054 grant has already run, an operator must
  re-run `--grant-runtime-product-dml` after 0.3 merges, then
  `--preflight-runtime-product-dml` must PASS. Until then authority, offers
  and quotes keep returning 503 exactly as today; nothing regresses.
- Risk: none functional; the runtime-scope unit tests encode the old boundary
  and must be deleted, not weakened.
- Reuse: none of the open drafts; #2656 (readiness probe) closes.

### Slice A — PMS manual-booking preview and rate plans (VAY-1422, VAY-647)

Goal: the New Booking modal lists the property's published offers as rate
plans, auto-fills nightly prices for the stay, and `POST /manual-bookings`
stores the computed totals. No credential dependency: everything reads
`pms.pricing_v2_*` on the ordinary login.

- **A.1 api** Implement `calculateManualBookingPreview`
  (`routes/pmsManualBookingPreviewCalculation.ts`) on the active publication:
  load it with the existing publication reader inside the caller's transaction
  (`lockCurrentPricingPublication` for the owner context), map the requested
  `ratePlanId` to the published offer (the catalog already exposes offers with
  their `ratePlanId`, `publicPricingOfferCatalog.ts:84`), price each stay with
  `calculateReplacementRoomStay` (`packages/domain-pms/src/replacementPricingCalculator.ts:113`)
  and keep `manualOverride` as the custom-rate branch; add-ons and guest policy
  stay as wired in `pmsManualBookingTransactionalPricing.ts`. Return
  `pricing_not_published` (409) instead of 503 when no publication exists.
  ~300 lines + a `.postgres.test.ts` that seeds one published property (reuse
  fixtures from `replacementPricingStore.integration.test.ts`). **2 days.**
- **A.2 api** Un-stub `listFlexibleRatePlans`/`getFlexibleRatePlan`
  (`pmsPricingReadModel.ts:133-145`) as read adapters over the publication
  (one entry per room: base offer, currency, cancellation terms head), so the
  room-types `ratePlans` payload used by pms-web (`services/calendar/index.ts:440`,
  `services/rooms/index.ts:374`) and the guest-policy evidence
  (`domain-booking/bookingPricingEvidence.ts:262-280`) read the new model
  without changing their contract. Keep `upsertFlexibleRatePlan` and the
  recurring writes returning 503 but with code `PRICING_RETIRED` and a
  pointer to the editor (retire the write routes in slice E). ~200 lines.
  **1 day.**
- **A.3 api** Un-stub `createRoomType`/`duplicateRoomType`
  (`pmsOperationsCommandRepository.ts:373, 517`) by removing the embedded
  rate seeding (rooms carry no prices; the editor does) and make
  `applyTargetBaseRateForMove` reprice the moved stay from the publication via
  A.1 (or return 409 `target_base_unavailable` if unpublished). ~150 lines +
  integration cases. **1 day.**
- **A.4 pms-web** `TargetManualBookingModal`: rate-plan dropdown from the
  published offers, default Flexible, hide custom rate unless Custom, summary
  row "Standard/Applied" from the preview response (VAY-1422 §3). ~250 lines.
  **1 day.** Browser check via the mocked-backend Playwright pilot
  (`npm run e2e:pms-web`) plus one manual run against a local stack.
- Risks: offer→`ratePlanId` mapping must be confirmed in the reader (first
  task of A.1); multi-season stays spanning a publication change are priced
  from the single active revision (documented, acceptable); legacy
  `pms.rate_rules`/season data of imported hotels is not consulted, matching
  the VAY-1546 decision.
- Reuse: no open PR implements this (all VAY-1422 work merged is UI-only).

### Slice B — onboarding pricing step (VAY-1943, VAY-1941/1942/1945)

Goal: a new hotel completes "Pricing" in the adaptive setup without the
legacy flexible-rate writer.

- **B.1 marketplace-web** `components/setup/adaptive/pricing/PricingStep.tsx`
  stops writing `flexible-rate-plan`/`recurring*`; it keeps currency and
  mandatory-charge confirmation (live routes) and embeds the first-setup form
  already built in pms-web (`components/pricing/FirstPricingSetup.tsx` +
  `services/api/replacementPricingClient.ts`), moved into a shared package
  (`packages/product-onboarding` or a new `packages/pricing-ui`). Completion =
  active publication with ≥1 offer per operating room (read via
  `GET /pricing-v2`). ~350 lines moved/changed. **2 days.**
- **B.2 api** Guest-policy readiness: with A.2 in place
  `flexible_rate_policy_missing` resolves from the publication's terms heads;
  verify `bookingGuestPolicyReadiness` and the Review step readiness
  (`booking_readiness_owner_unavailable`) against a property that only has
  pricing-v2 data; fix any remaining legacy reads. ~100 lines + integration
  test. **1 day.**
- **B.3 evidence** Repeat the VAY-1943 deployed QA path (property
  `6fbb5870…`) once slice 0.3 + VAY-2054 grant are live: pricing step → guest
  policy confirmed → Booking review ready. VAY-1991 staging identity reused.
- Risks: PricingStep is 1.3k lines of legacy state (`pricingState.ts`
  `flexibleRatePlans`); replacing rather than adapting keeps the PR small.
  Draft-terms editing (VAY-1996/1997/1998) is **not** required for first
  setup and stays a later slice.
- Reuse: none; drafts #1912/#1928/#1930 are superseded by merged content.

### Slice C — public offers and quotes on booking-web (VAY-1543)

Goal: a hotel with authority `vayada` and a publication is bookable on
booking-web with pay-at-property, on the ordinary login.

- **C.1** Depends on slice 0 and the VAY-2054 grant. Verify in production:
  authority GET/PUT 200, `/pricing-offers` 200, quote 201 for the synthetic
  hotel; booking-web book page renders prices (`BookPageClient`,
  `useReplacementQuote`). No code beyond slice 0; evidence only. **0.5 day.**
- **C.2 api + booking-web** Replace the slug allowlist gate on acceptance with
  the per-hotel authority (`vayada`) + publication check that offers already
  perform; keep the env allowlist as an additional kill switch until the first
  real hotel is accepted. Retire the old public flow entry points that still
  hit `PRICING_UNAVAILABLE` on booking-web: `HotelContext` `/offers`
  (`HotelContext.tsx:159-177`), `/calendar`, POST `/bookings` legacy snapshot
  → route the home/search availability to `/pricing-offers` and remove the
  legacy snapshot path or return 410. ~300 lines. **2 days.**
- **C.3 api** Online card payment branch of the quote/acceptance
  (`publicPricingPaymentAmounts.ts`, `financePricingAcceptanceTerms.ts`): wire
  the existing Stripe provider for `online_card`; pay-at-property first.
  ~250 lines + `.postgres` tests. **2 days.**
- Tests: `bookingPricingAuthority.integration`, `storePricingAcceptance.postgres`,
  `pricingAcceptanceWriter.postgres`, `pricingInventoryAdoption.postgres` on
  PG16/17; `npm run e2e:booking-web` against the synthetic hotel. Add the
  pricing `.postgres` files to the `api_postgres` pms shard (CI gap).
- Risks: the quote → acceptance → PMS adoption path is tested but has never
  run end to end in production; keep the kill switch. Tenant isolation: slug
  resolution under lock, append-only quotes, acceptance re-locks; a request
  cannot name a property.
- Reuse: merged already (#2438, #2499, #2503, #2548, #2551, #2576, #2585,
  #2615–#2691). The `fm/vay-1543-*` drafts (#2077–#2430) are the stacked
  review history of the squash-merged #2438 ("consolidates the stack while
  preserving the existing draft PRs as its detailed review history"); none
  carries content that main lacks. Close them.

### Slice D — Channex consumption (VAY-2030, VAY-1528, VAY-1547–1550)

Goal: published offers reach Channex rate plans and nightly ARI.

- **D.1** Nothing changes in the login model: `readPublishedPricingForChannexJob`
  and the offer bootstrap already run as `vayada_next_channex_management_worker`
  with the CI-proven boundary. Wire `channexPublishedNightPrices.ts` into the
  closed-upload dispatcher and replace `channexManagementPlans.ts:242-262`
  provisioning/ARI plan stubs with the published nightly projection
  (`projectReplacementRoomNight`). ~300 lines. **2 days.**
- **D.2** Retire `pmsChannelDatePrices.ts` and the `date-prices` route
  (`pmsChannexManagement.ts:62-90`): date-specific prices are part of the
  publication, not a side channel. ~80 lines deleted. **0.5 day.**
- **D.3** Activation (VAY-2030) and restrictions (VAY-1528) per their own
  contracts, after D.1, observe-only first (`pricing-migration-integration.md`).
- If the worker needs additional SELECTs on pricing-v2 tables, add a new RLS
  helper (never rewrite the hash-pinned `platform.channex_management_worker_*`
  functions) and recompute `POLICY_DIGEST` in
  `jobs/channexManagementWorkerBoundary.ts`.
- Reuse: none. The `fm/vay-1545-*` and Channex drafts (#2142–#2414,
  #1756–#1772) are the review history of the squash-merged #2447 and were
  rebuilt again by VAY-2036/2030/2041; close them.

Open-PR classification (`open-pricing-prs.md`, 191 PRs matching "pricing"):
merged-content 30, superseded 159, live 1 (#2656, the private-service
readiness probe → close), unknown 1 (#1748 pre-reset design doc → close).
No open PR is a reuse candidate for any slice.

### Slice E — cleanup (after C is accepted on one real hotel)

Drop the 0409 scope table/views and the seven pricing-only policy sets with
digest recompute; delete the legacy flexible-rate/recurring write routes and
`pricingReset.test.ts` assertions that pin 503s; remove the three superseded
`engineering/pricing-*` documents; platform: destroy the security groups via a
reviewed plan, delete the #344 apparatus, close #417/#251, drop the protected
list entries. The digest and enumeration pins listed in §3.3 phase 2 make this
a cross-cutting change; the optional `ENABLE ALWAYS` on the three append-only
triggers belongs in the same migration. ~4 PRs. **3 days.**

Total: roughly 21 engineer-days across 13–15 PRs. First production-visible
result (slice A) in week 1 without waiting on any grant.

## 5. Test evidence and acceptance

- Native: PG16 and PG17 via the existing `api_postgres` matrix; add the eight
  pricing `.postgres.test.ts` files and the five authority/store/commands/
  offer-owners/acceptance integration files to the pms shard (today only two
  pricing tests run in CI). Locally: `TEST_DATABASE_URL` on a migrated
  database, `npm --workspace vayada-api run test -- --no-file-parallelism <files>`.
- Negative cases to keep: stale `expectedRevision`, replayed `request_id`,
  revoked membership between admission and transaction, moved slug, unpublished
  profile, cross-organization quote (property/organization taken from the
  locked publication), UPDATE/DELETE on revisions/quotes denied by trigger,
  DELETE on heads denied by grant, `FOR SHARE OF h,r` on heads and revisions
  succeeds for the ordinary login, and a guard test that no quote read uses a
  row lock (the `pricing_quotes` narrowing has no `UPDATE`).
- Browser: `npm run e2e:booking-web` (synthetic hotel), `npm run e2e:pms-web`
  (mocked backend) plus one manual run of the New Booking modal and the
  pricing editor.
- Two-Owner acceptance: after slice C, both original Owners (Animals Ahangama,
  Sri Journeys) read their authority, publish once, and a pay-at-property quote
  is issued and accepted on the `next-*` hosts; the resulting PMS reservation
  shows the published price. No real payment.

## 6. Ticket disposition

"Done" means the code is on main and only human acceptance is missing; the
status change itself stays with the human.

| Group                                       | Tickets                                                                                                                                                                                           | Disposition                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Decision umbrella                           | VAY-1538                                                                                                                                                                                          | still needed as the umbrella until slice C; VAY-2057 supplies the credential decision         |
| Contracts                                   | VAY-1539, VAY-1554, VAY-1555, VAY-1556                                                                                                                                                            | done (contracts on main, consumed by code)                                                    |
| Storage                                     | VAY-1540, VAY-1557, VAY-1558                                                                                                                                                                      | done (0300–0311 on main)                                                                      |
| Reset                                       | VAY-1546                                                                                                                                                                                          | done (#1764 merged; leftovers handled in slice A.3/E)                                         |
| Publication pipeline (VAY-1541 children)    | VAY-1559, VAY-1560, VAY-1561, VAY-1667, VAY-1878, VAY-1925–1935, VAY-1936, VAY-1937, VAY-1938, VAY-1939, VAY-1940, VAY-1941                                                                       | done (merged via #2438 and successors); VAY-1938/1939/1941 need browser acceptance in slice B |
| Draft terms                                 | VAY-1996, VAY-1997, VAY-1998, VAY-1999                                                                                                                                                            | still needed, after slice B (not required for first setup)                                    |
| Editor features (VAY-1544 children)         | VAY-1942, VAY-1945, VAY-1947–1951, VAY-1955, VAY-1957–1961, VAY-1965, VAY-1966, VAY-1968, VAY-1969, VAY-1971, VAY-1974–1980, VAY-1982, VAY-1984, VAY-1986, VAY-1987, VAY-1989, VAY-1992, VAY-1993 | done (components on main); one browser acceptance pass in slice B closes them                 |
| Editor evidence                             | VAY-1990, VAY-1991                                                                                                                                                                                | still needed (slice A/B evidence; VAY-1991 identity reused)                                   |
| Authority / offers / quotes                 | VAY-1543                                                                                                                                                                                          | still needed → slices 0 and C; the private-service and #344/#417 parts are obsolete           |
| Manual booking                              | VAY-1422, VAY-647                                                                                                                                                                                 | still needed → slice A                                                                        |
| Onboarding                                  | VAY-1943 (+VAY-1051)                                                                                                                                                                              | still needed → slice B unblocks                                                               |
| Channex reads                               | VAY-1952, VAY-1953, VAY-1954, VAY-1956, VAY-1967, VAY-1970, VAY-1946, VAY-1944                                                                                                                    | done (worker reads on main, CI-proven)                                                        |
| Channex offer lifecycle (VAY-1545 children) | VAY-1972, VAY-1973, VAY-1977, VAY-1983, VAY-1985, VAY-1988, VAY-1994, VAY-1995, VAY-2000–2012, VAY-2014–2016, VAY-2018                                                                            | done (VAY-1545 and VAY-2036 Done; the `fm/vay-1545-*` drafts are #2447's review history)      |
| Channex activation                          | VAY-2030, VAY-1528, VAY-1547, VAY-1548, VAY-1549, VAY-1550                                                                                                                                        | still needed → slice D                                                                        |
| Prerequisites                               | VAY-2054, VAY-2056                                                                                                                                                                                | VAY-2054 needed for slice C (and 0.3 is its follow-up); VAY-2056 independent                  |
| Obsolete                                    | private pricing command service, per-property logins, `pricing-writer-hold`, verification reader, platform #417/#251, app #2656                                                                   | obsolete under this plan                                                                      |

## 7. Independent review

An independent subagent reviewed §3 against the code and migrations
(2026-10-07). Verified: quote property/organization come from the locked
publication and the 0309 CHECK, authority PUT cannot reparent across
properties, public offers do not depend on RLS, append-only triggers hold for
the ordinary login, the seven policy sets are inert for it, and the only new
real-`UPDATE` target is the authority head. Findings folded in: the original
"no UPDATE on revisions" narrowing would have broken every `FOR SHARE OF h,r`
lock (blocker, fixed in §3.2 and slice 0.3); the grant mode must be re-run
after 0.3 (slice 0.3); three test files that encode the old boundary (slice
0.1); the full list of 0409 pins (§3.3, slice E); the organization binding is
application-enforced, not FK-enforced (§3.2); line references corrected.

## 8. Risks and open decisions for the human

1. **Accept application-level tenant isolation for pricing writes**, the same
   as VAY-2054 accepted for the other 230 written relations. The 2026-09-22
   "database-enforced per-property scope" decision is reversed by this plan;
   the FK and append-only triggers keep the two properties that mattered
   (no cross-property head reparent, no history rewrite).
2. **Narrowings**: table-level only: no DELETE on heads and revisions, no
   UPDATE/DELETE on quotes. Revisions keep `UPDATE` purely for the `FOR SHARE`
   lock; the trigger rejects real updates. A column-level `UPDATE (revision)`
   on heads or a lock-only policy for revisions (identity precedent) is
   possible but adds a second grant mode; not recommended.
3. **Legacy rate model**: slice A reads prices only from pricing-v2
   publications; hotels imported with `pms.rate_rules` seasons get no prices
   until they publish in the editor. Confirms VAY-1546.
4. **Onboarding step**: embed the first-setup editor (recommended) vs. link out
   to PMS → Pricing.
5. **Platform cleanup**: destroy the 9 live security-group resources via a
   reviewed plan; close #417 and #251; delete the `vay1543-pricing-verification`
   environment.
6. **Order**: slice A before the VAY-2054 grant lands (recommended, no
   dependency) vs. waiting to ship everything behind C.
7. **CI gap**: adding ~13 pricing PG tests to the pms shard lengthens the
   matrix by a few minutes; alternative is a nightly job.
