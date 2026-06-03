# Backend database restructure plan

_VAY-605 decision record. Inputs: VAY-600 WorkOS identity architecture,
VAY-601 Ask Intelligence architecture, VAY-602 target TypeScript backend
structure, VAY-604 AI-agent bookability, and the VAY-605 schema audit._

## Recommendation

Do not start the backend rewrite with a big-bang database rewrite.

Start with an explicit ownership model, additive identity/resource-link tables,
and read models for the new AI and distribution contracts. Keep the current
auth, marketplace, booking, and PMS databases serving production traffic until a
specific domain has a tested migration path.

The target should be:

- one internal identity and authorization model for users, organizations,
  memberships, permissions, entitlements, and resource links;
- domain-owned writes, where each table has one authoritative owner;
- typed read models for cross-domain consumers instead of product services
  directly opening each other's database pools;
- public bookability data separated from authenticated hotel-owner intelligence;
- migration adapters with explicit expiry notes, validation, and rollback.

VAY-603 should use this plan as the database input to the integrated roadmap.
The roadmap should not assume that the TypeScript backend can safely inherit
the current table boundaries as permanent boundaries.

## Current schema audit

The repo currently has separate migration histories for:

| Area        | Migration path                    | Current role                                                                                                                                                                                          |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | `auth-db/migrations`              | Shared local identity, consent, GDPR, local password reset, email verification, TOTP, login audit/rate limit.                                                                                         |
| Marketplace | `apps/marketplace-api/migrations` | Creator profiles, hotel profiles/listings, collaboration offers, collaborations, deliverables, chat, trips, notifications, invite/newsletter data.                                                    |
| Booking     | `apps/booking-api/migrations`     | Public booking hotel profile/config, translations, add-ons, promo codes, public events, pricing configuration, platform status, Lodgify remnants.                                                     |
| PMS         | `apps/pms-api/migrations`         | Operational hotels, room types, rooms, bookings, room blocks, payments, payouts, affiliates, channel manager mappings, guest messaging, check-in/check-out, booking notes/events, module activations. |

Important current tables include:

| Area        | Tables found in migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth        | `users`, `password_reset_tokens`, `email_verification_codes`, `email_verification_tokens`, `email_change_tokens`, `cookie_consent`, `consent_history`, `gdpr_requests`, `totp_secrets`, `totp_recovery_codes`, `login_audit_log`, `login_rate_limit`.                                                                                                                                                                                                                                                                                                                |
| Marketplace | `creators`, `creator_platforms`, `creator_ratings`, `hotel_profiles`, `hotel_listings`, `listing_collaboration_offerings`, `listing_creator_requirements`, `collaborations`, `collaboration_deliverables`, `chat_messages`, `trips`, `external_collaborations`, `notifications`, `invite_codes`, `newsletter_preferences`.                                                                                                                                                                                                                                           |
| Booking     | `booking_hotels`, `booking_hotel_translations`, `booking_addons`, `booking_promo_codes`, `booking_events`, `commission_rate_changes`, `lodgify_connections`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| PMS         | `hotels`, `room_types`, `rooms`, `bookings`, `booking_rooms`, `booking_drafts`, `room_blocks`, `payments`, `payouts`, `hotel_payment_settings`, `cancellation_policies`, `affiliates`, `affiliate_clicks`, `affiliate_payout_settings`, `channex_connections`, `channex_room_type_mappings`, `channex_rate_plan_mappings`, `channex_booking_mappings`, `channex_channel_markups`, `message_threads`, `messages`, `booking_events`, `booking_notes`, `booking_change_requests`, `booking_checkin_records`, `booking_checkout_records`, `property_module_activations`. |

The main database problems are structural:

- Auth still centers on `users.type` and `users.is_superadmin`, while VAY-600
  needs WorkOS provider identity plus Vayada-owned organizations, memberships,
  resource links, permissions, entitlements, and audit.
- Product ownership is stored as direct `user_id` columns on resources such as
  `booking_hotels`, PMS `hotels`, marketplace `hotel_profiles`, marketplace
  `creators`, and PMS `affiliates`. This does not model multi-member hotel
  organizations, creator workspaces, affiliates, or platform staff cleanly.
- Product services directly open other product databases. Examples include PMS
  reading booking-engine hotel identity/payment data, booking-api reading PMS
  booking metrics, and marketplace-api reading PMS affiliate data.
- Public bookability data is split across booking profile/config tables, PMS
  room/rate/availability/booking tables, and booking-web URL behavior. There is
  no stable external quote/read model.
- Ask Intelligence does not yet have curated metric views, evidence catalogs,
  answer audit, tool-call traces, or repeatable setup-completeness snapshots.
- Operational facts, public distribution facts, finance facts, and owner-facing
  setup facts often live in the same tables or same service contracts.

## Target domain ownership

Each target domain should own writes to its authoritative tables. Other domains
should consume typed services, read models, or events.

| Domain                          | Owns                                                                                                                                                        | Initial database posture                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and authorization      | Internal users, WorkOS identity mappings, organizations, memberships, permissions, resource links, product entitlements, product audit events.              | Add tables to `auth-db` first. Keep `users.id` stable. Keep legacy auth columns as compatibility data until WorkOS and RequestContext are live.                                    |
| Hotel/property catalog          | Canonical internal property identity, organization links to booking/PMS/marketplace resources, normalized public/private profile attributes.                | Start as a registry/read model over existing `booking_hotels`, PMS `hotels`, and marketplace `hotel_profiles`/`hotel_listings`. Do not move all hotel profile columns immediately. |
| Booking and direct checkout     | Quote sessions, checkout context, booking lifecycle contract, guest booking records, booking status, cancellation/change flows.                             | PMS `bookings` stays operational source during transition. Add quote/deep-link state separately before changing booking creation tables.                                           |
| PMS operations                  | Rooms, room types, inventory, room blocks, operational booking assignment, check-in/out, notes, housekeeping-style facts, channel manager sync state.       | Preserve PMS operational tables. Split only after adapters and validation exist.                                                                                                   |
| Marketplace                     | Creators, creator platforms, hotel listings for collaborations, collaboration offers, deliverables, ratings, negotiation/chat.                              | Preserve marketplace tables. Add organization/resource links instead of using `users.type` as the workflow gate.                                                                   |
| Finance                         | Payment settings, payments, payouts, commissions, affiliate payout settings, billing/pricing configuration, audit of rate/commission changes.               | Keep current payment/payout tables where they are until finance ownership is explicitly designed. Add entitlements and billing links in auth/platform first.                       |
| Distribution and AI bookability | Public hotel bookability profile, quote read model, freshness metadata, typed unavailable reasons, deep-link context, external API clients and rate limits. | Add public read-model tables or materialized views after profile/quote contract is defined. This is public and read-only for external agents.                                      |
| Ask Intelligence                | Metric catalog, setup-completeness snapshots, evidence catalog, answer records, conversations, agent runs, tool-call traces, unavailable-data states.       | Add intelligence tables after RequestContext and curated metric definitions exist. Keep tools read-only in MVP.                                                                    |
| Jobs/events/audit               | Durable side-effect jobs, idempotency keys, retries, dead-letter visibility, product audit correlation.                                                     | Introduce as backend platform tables/shared infrastructure. Do not continue fire-and-forget side effects as the migration norm.                                                    |

## Identity and authorization tables

These are the first additive schema changes because every later domain depends
on a stable request and resource model.

Recommended tables:

| Table                             | Purpose                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_identities`             | Maps WorkOS users and other future providers to `users.id`. Stores provider user ID, provider email cache, verification state, raw profile metadata, first/last seen timestamps.      |
| `organizations`                   | Internal tenant/business container. Kinds should include `platform`, `hotel_group`, `creator_workspace`, and `affiliate_partner`. Stores WorkOS organization mapping when applicable. |
| `organization_memberships`        | Internal membership for `user_id` and `organization_id`, linked to WorkOS membership when applicable. Stores status, role slug, timestamps, and invite/deprovision state.             |
| `permission_catalog`              | Stable product permission keys such as `pms.booking.update`, `booking.settings.manage`, `marketplace.collaboration.review`, and `platform.user.suspend`.                              |
| `role_permission_grants`          | Maps internal role slugs to permission keys, scoped by organization kind and product.                                                                                                 |
| `membership_permission_overrides` | Optional explicit grants/denies for edge cases. This can wait until role grants are insufficient.                                                                                     |
| `organization_resource_links`     | Links an organization to product resources such as `booking_hotel`, `pms_hotel`, `hotel_profile`, `hotel_listing`, `creator_profile`, `affiliate`, and payout/billing accounts.       |
| `product_entitlements`            | Product/module access and limits for the organization or linked resource. Supports plan, enabled modules, active/suspended state, and expiry.                                         |
| `product_audit_events`            | Application audit trail for actor, organization, target resource, action, before/after metadata, request metadata, and WorkOS event correlation.                                      |

Rules:

- Preserve `users.id` as the internal principal ID.
- Add `external_identities` instead of replacing product table foreign keys with
  WorkOS IDs.
- Treat `users.type`, `users.is_superadmin`, and product `user_id` owner fields
  as compatibility columns after the new model is introduced.
- Resolve every authenticated request to:

```text
provider identity
-> internal user
-> selected organization
-> active membership
-> permissions
-> linked product resource
-> entitlement and product state
```

## Distribution and AI bookability tables

VAY-604 separates public bookability from authenticated owner intelligence.
The bookability layer should serve external agents/search systems without
exposing private tenant data.

Recommended structures:

| Table or read model                 | Purpose                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_hotel_bookability_profiles` | Versioned public snapshot for hotel identity, canonical URLs, custom-domain URL, location, images, amenities, policies, payment capabilities, supported quote parameters, completeness, and generated/freshness metadata. |
| `public_room_offer_snapshots`       | Optional denormalized room/rate snapshot for public quote generation. Use only for fields that are safe to expose publicly.                                                                                               |
| `quote_sessions`                    | Deterministic quote identity/hash, request parameters, selected offers, totals, policy text/version, expiry, freshness, booking URL, promo/referral context, and typed unavailable reasons.                               |
| `booking_deep_link_contexts`        | Short-lived state that lets booking-web open the same dates, guests, room/rate, locale, currency, promo, and referral context returned by the quote API.                                                                  |
| `external_api_clients`              | Client identity, allowed surfaces, status, terms version, contact, rate-limit tier, and revocation state for partner/tool clients.                                                                                        |
| `external_api_usage_events`         | Request audit and abuse/rate-limit signals for public AI/partner API access.                                                                                                                                              |

Rules:

- The public profile and quote contracts should not expose guest PII,
  unpublished room/rate data, private owner settings, payout data, or internal
  operational notes.
- The quote API should return a quote identity/hash and expiry even before
  external agents can create bookings directly.
- MCP/tool integrations should call the same bookability profile and quote
  contracts; they should not become a separate source of truth.
- Booking creation by external tools should remain quote/preview plus checkout
  redirect until explicit guest confirmation, payment/fraud controls,
  idempotency, and audit are implemented.

## Ask Intelligence tables

VAY-601 defines Ask Intelligence as an authenticated, read-only hotel-owner
agent. It needs repeatable evidence, not arbitrary model SQL.

Recommended structures:

| Table or view                  | Purpose                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `metric_definitions`           | Canonical metric keys, descriptions, units, filters, visibility, and permission requirements.                                                   |
| `metric_snapshot_runs`         | Records when curated metric snapshots were generated, by source, resource, date range, freshness, and status.                                   |
| `setup_completeness_snapshots` | Owner/admin-facing setup gaps for profile, policy, payment, rates, inventory, images, location, direct-booking URL health, and agent-readiness. |
| `ai_evidence_catalog`          | Registry of allowed evidence tools/views, products, resource types, permissions, freshness expectations, and unavailable-data behavior.         |
| `ask_conversations`            | Conversation metadata, user, organization, resource scope, language, state, and retention policy.                                               |
| `ask_runs`                     | One answer attempt, model/prompt/schema version, status, question, scope, confidence, caveats, and output metadata.                             |
| `ask_tool_calls`               | Tool name, input scope, result status, evidence IDs, latency, errors, and authorization/unavailable outcomes.                                   |
| `ask_answer_audits`            | Material claims, evidence references, generated answer envelope, suggested actions, and review/debug metadata.                                  |

Rules:

- Ask Intelligence tools must enforce authorization server-side.
- Store evidence references and aggregate metadata by default, not full guest PII
  or raw cross-tenant data.
- Financial/payout metrics require stricter permission keys than general
  booking or setup metrics.
- Suggested actions stay non-destructive in the MVP. Executable actions need a
  separate approval/idempotency/audit workflow.

## Preserve, redesign, retire, backfill

### Preserve

- `users.id` as the stable internal principal.
- Existing product resource IDs for `booking_hotels`, PMS `hotels`,
  marketplace `hotel_profiles`/`hotel_listings`, `creators`, `affiliates`,
  bookings, payments, payouts, rooms, room types, and channel mappings.
- Current guest checkout and booking lifecycle semantics.
- Public booking URLs through redirects or compatibility adapters.
- Channex, Stripe, Xendit, Lodgify cleanup state, email, affiliate, and
  marketplace integration behavior until each integration is explicitly moved.
- Consent history and GDPR request linkage.

### Redesign

- `users.type` as product authorization.
- `users.is_superadmin` as platform authorization.
- Direct resource ownership through product `user_id` columns.
- `X-Hotel-Id` as hidden global state. It can remain as an HTTP compatibility
  input, but domain logic should receive an explicit resolved resource context.
- Cross-product reads through `AuthDatabase`, `PmsDatabase`,
  `MarketplaceDatabase`, and `BookingEngineDatabase` as normal integration.
- Booking quote, checkout context, payment eligibility, and deep-link state as
  one explicit domain contract.
- Hotel setup completeness and agent-readiness as reusable read models.
- Metrics as curated definitions/views instead of ad hoc prompt/database logic.
- Side effects as durable jobs/events with audit, retries, idempotency, and
  dead-letter visibility.

### Retire after migration

- Local password login and bcrypt session issuance for migrated users.
- `password_reset_tokens` as a Vayada-owned auth flow after WorkOS is the
  session authority.
- Local account email verification code/token flows after WorkOS owns account
  identity verification for migrated users.
- Local `totp_secrets` and `totp_recovery_codes` after WorkOS MFA is enforced.
- Local login rate limiting that protects only retired password endpoints.
- Legacy marketplace `users` tables that have already been removed from product
  ownership, except for any migration artifacts needed for audit.
- `lodgify_connections` once the dropped Lodgify integration is confirmed to
  have no production dependency.

### Backfill

- `external_identities` from existing `users` once WorkOS users are created or
  linked.
- `organizations` from current hotel/admin/creator/affiliate ownership:
  platform organization for Vayada staff, hotel-group organizations for hotel
  businesses, creator-workspace organizations for creators, and
  affiliate-partner organizations for affiliates.
- `organization_memberships` from existing `users.type`, `is_superadmin`, and
  owner/admin associations.
- `organization_resource_links` from `booking_hotels.user_id`, PMS
  `hotels.user_id`, marketplace `hotel_profiles.user_id`, marketplace
  `creators.user_id`, PMS `affiliates.user_id`, and any explicit setup handoff
  mappings.
- `product_entitlements` from booking pricing configuration, platform status,
  PMS `property_module_activations`, billing plans, enabled modules, and
  payment/setup state.
- Public bookability snapshots from `booking_hotels`, booking translations,
  booking add-ons/policies/payment config, PMS room types, PMS availability,
  PMS payment settings, and booking-web canonical URL rules.
- Ask Intelligence setup snapshots and metrics from booking events, PMS
  bookings/payments/room inventory, marketplace collaborations, and platform
  status.

## Migration sequence

### Phase 0: Inventory and contracts

- Produce a full table/column inventory with owners, current writers, current
  readers, PII classification, and migration risk.
- Confirm the target domain ownership map.
- Define RequestContext, resource-link, bookability quote, and Ask Intelligence
  evidence contracts before writing migrations that depend on them.

### Phase 1: Add identity/resource-link schema

- Add `external_identities`, `organizations`, `organization_memberships`,
  `permission_catalog`, `role_permission_grants`,
  `organization_resource_links`, `product_entitlements`, and
  `product_audit_events`.
- Keep all current code paths working.
- Add migration tests and fixtures for common user/resource shapes.

### Phase 2: Backfill and validate

- Backfill organizations, memberships, and resource links from current product
  data.
- Run dual-read validation: legacy ownership checks and new resource-link checks
  should agree for seeded and production-like data.
- Record mismatches as data cleanup issues before enforcement.

### Phase 3: RequestContext enforcement

- Introduce TypeScript RequestContext or Python compatibility middleware that
  resolves user, organization, permission, resource links, and entitlement.
- Keep `X-Hotel-Id` as an input but not as hidden domain state.
- Gate selected endpoints with the new resource-link checks while preserving
  fallback behavior behind a feature flag.

### Phase 4: Public bookability read models

- Add the public profile and quote/deep-link schemas or materialized read
  models.
- Implement freshness metadata and typed unavailable reasons.
- Validate quote parity against existing booking/PMS frontend flows.

### Phase 5: Ask Intelligence data layer

- Add metric definitions, setup-completeness snapshots, evidence catalog,
  conversations, runs, tool calls, and answer audits.
- Wire only predefined read-only tools.
- Validate that evidence tools use RequestContext and cannot cross tenant
  boundaries.

### Phase 6: Domain table splits and renames

- Only after adapters and read models are stable, decide which existing tables
  should move, split, or be renamed.
- Prioritize confusing ownership boundaries, not cosmetic renames.
- Keep compatibility views or adapters for old Python routes until frontend and
  public clients have moved.

### Phase 7: Retire legacy auth and cross-pool reads

- Stop creating local password sessions.
- Remove TOTP/password/email-verification dependency for migrated users.
- Remove `users.type`, `is_superadmin`, and direct product `user_id` checks from
  authorization decisions after replacement coverage is complete.
- Remove normal cross-product database pools from services. Keep only approved
  migration adapters until their expiry date.

## Coexistence and rollback

During migration:

- Python services remain the production writers for existing product tables
  until each domain is migrated.
- TypeScript services can read existing tables through typed adapters or read
  models. New TypeScript code should not add raw product DB pools as the default
  integration style.
- New tables should be additive and nullable where needed until backfill and
  validation pass.
- Dual-read before dual-write. Prefer backfilled read models and validation
  reports before any write ownership change.
- Feature-flag enforcement changes so rollback can return to legacy checks
  without dropping schema.
- Use compatibility views/adapters for public URLs and old frontend contracts.
- Keep migration scripts idempotent and safe to re-run locally/staging.

Rollback posture:

- Additive migrations roll back operationally by disabling feature flags and
  ignoring new tables.
- Backfills must log source rows, target rows, counts, and mismatches so they
  can be rerun or corrected.
- Any future destructive migration needs an archived backup/export, a verified
  restore path, and a separate approval ticket.
- Do not drop legacy auth or ownership columns until migrated traffic has run
  through the new model and data parity checks have passed.

## Validation requirements

For every schema implementation ticket:

- Run migrations locally against the relevant database.
- Add migration tests or fixture checks for expected rows and constraints.
- Compare row counts and uniqueness for backfilled entities.
- Validate PII classification and public/private exposure for new read models.
- Add contract tests for RequestContext resource resolution, quote output, or
  evidence output depending on the domain.
- Include staging dry-run instructions and rollback notes.
- For production auth DB changes, remember that auth migrations do not
  auto-run in production. They require an explicit reviewed operation against
  RDS using the auth migration script.

Suggested validation checks by domain:

| Domain           | Required validation                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity/auth    | WorkOS ID uniqueness, internal user mapping, active membership, permission resolution, legacy/new ownership parity.                                                      |
| Resource links   | One organization can link to many resources, one resource can reject ambiguous ownership unless explicitly allowed, deleted/suspended resources do not authorize access. |
| Bookability      | Quote parity with existing booking flow, no private fields, correct cache/freshness metadata, typed unavailable reasons, deep-link round trip.                           |
| Ask Intelligence | Evidence tools cannot cross tenant scope, unavailable states are explicit, answer audits reference evidence, PII is minimized.                                           |
| Finance          | Payment/payout visibility gated by finance permissions, totals reconcile with existing payment/payout rows, commission changes are audited.                              |
| Jobs/events      | Idempotency keys, retry behavior, dead-letter visibility, audit correlation, no duplicate customer-facing side effects.                                                  |

## First schema implementation tickets

These are the first small, testable tickets VAY-603 should schedule after this
plan is accepted.

1. **Inventory current database ownership and PII**
   - Scope: generate a table/column inventory for auth, marketplace, booking,
     and PMS with current writers, readers, product owner, PII category,
     retention sensitivity, and migration risk.
   - Validation: inventory includes every table from the migration histories,
     marks unknown ownership explicitly, and links to source migration files.

2. **Add internal organization and resource-link schema**
   - Scope: add `organizations`, `organization_memberships`,
     `permission_catalog`, `role_permission_grants`,
     `organization_resource_links`, `product_entitlements`, and
     `product_audit_events` as additive auth-db migrations.
   - Validation: local auth migration run, constraint tests, fixture inserts
     for platform, hotel group, creator workspace, and affiliate partner.

3. **Add WorkOS external identity mapping schema**
   - Scope: add `external_identities` and WorkOS mapping columns/constraints
     needed by VAY-600.
   - Validation: uniqueness tests for provider user IDs, nullable bootstrap
     behavior, and compatibility with existing `users.id`.

4. **Backfill organizations, memberships, and resource links**
   - Scope: create a dry-run-capable backfill from current `users.type`,
     `is_superadmin`, `booking_hotels.user_id`, PMS `hotels.user_id`,
     marketplace `hotel_profiles.user_id`, marketplace `creators.user_id`, and
     PMS `affiliates.user_id`.
   - Validation: source/target counts, mismatch report, rerunnable dry run, and
     fixture tests for users with multiple hotels.

5. **Define RequestContext database contract**
   - Scope: define the query contract that resolves provider identity,
     internal user, selected organization, permissions, linked resource, and
     entitlement. Include compatibility inputs for current JWT and
     `X-Hotel-Id`.
   - Validation: unit tests for allowed/denied hotel, creator, affiliate, and
     platform scopes.

6. **Define public bookability profile and quote schema**
   - Scope: specify tables/read models for public profile, quote sessions,
     freshness, unavailable reasons, and booking deep-link context.
   - Validation: contract fixtures for bookable, sold-out, payment-disabled,
     min-stay, max-stay, same-day cutoff, promo/referral, and stale data cases.

7. **Add Ask Intelligence metric and evidence schema**
   - Scope: add metric catalog, setup-completeness snapshots, evidence catalog,
     conversations, runs, tool calls, and answer audit tables for the read-only
     MVP.
   - Validation: evidence fixture tests, tenant-scope authorization tests, no
     raw guest PII in answer audit fixtures by default.

8. **Create migration validation harness**
   - Scope: add shared scripts/tests for migration dry runs, row-count checks,
     uniqueness checks, ownership parity checks, and rollback notes.
   - Validation: harness runs locally for at least auth-db and one product DB,
     prints actionable mismatch reports, and fails on ambiguous ownership.

9. **Deprecate legacy local auth and ownership fields**
   - Scope: create a deprecation plan for local password/TOTP/email verification
     tables, `users.type`, `users.is_superadmin`, direct product `user_id`
     ownership checks, and `X-Hotel-Id` hidden domain state.
   - Validation: every deprecated field/table has a replacement owner, rollout
     flag, parity check, and earliest safe removal condition.

## Open decisions for VAY-603

VAY-603 should decide these in the integrated roadmap:

- Whether the identity/resource-link migrations land before the first
  TypeScript backend app or in the first TS backend PR.
- Whether `auth-db` remains the home for all identity/resource-link tables or
  whether a new platform database is introduced later.
- Which product surface becomes the first RequestContext enforcement pilot:
  booking admin hotel selection, PMS hotel admin, marketplace hotel profile, or
  platform admin.
- Whether bookability profile/quote read models are implemented as tables,
  materialized views, or generated responses with cache metadata in the first
  phase.
- Which metric definitions are necessary for the Ask Intelligence MVP and which
  should wait for later enrichment.
- The first side-effect path to move into jobs/events.

## Acceptance signal

This plan is ready to feed VAY-603 when:

- the team agrees that database ownership should be domain-based and additive
  first, not a big-bang rewrite;
- `users.id` remains the internal principal while WorkOS IDs live in mapping
  tables;
- organization/resource links become the replacement for `users.type`,
  `is_superadmin`, direct product `user_id` checks, and hidden `X-Hotel-Id`
  authorization state;
- public AI bookability and authenticated Ask Intelligence remain separate data
  domains;
- the first implementation tickets above are sequenced into the roadmap.
