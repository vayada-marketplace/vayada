# Target TypeScript backend structure

_VAY-602 decision record. Inputs: VAY-600 WorkOS identity architecture,
VAY-601 Ask Intelligence architecture, and VAY-604 AI-agent bookability
recommendation._

## Recommendation

Move Vayada toward a **TypeScript modular backend**, not a direct port of the
current FastAPI files and not a premature microservice split.

The target should be one cohesive backend codebase with explicit domain modules,
shared infrastructure packages, product API adapters, and compatibility facades
for old frontend/public routes during migration. The first TypeScript backend
surface should be small and additive. Python services should keep serving
production traffic until individual domains are migrated behind tested,
observable contracts.

The backend structure should be organized around these principles:

- WorkOS owns provider authentication and provider organization membership
  state; Vayada owns internal users, organizations, resource links,
  permissions, product authorization, billing entitlements, and product audit.
- Every authenticated request resolves a typed `RequestContext` before domain
  code runs: user, selected organization, memberships, permissions, linked
  product resources, locale, currency, and request/audit metadata.
- Product domains expose typed application services. Routers/controllers should
  translate HTTP to domain calls, not contain business rules, SQL, emails,
  third-party side effects, and response shaping in one file.
- Cross-domain access happens through typed domain interfaces or read models,
  not by one product directly opening another product's database pool.
- Background work uses explicit job/event infrastructure with idempotency,
  retries, failure visibility, and audit links. Avoid untracked
  `asyncio.create_task`-style side effects.
- Public AI bookability is a separate distribution domain from the authenticated
  hotel-owner Ask Intelligence agent.
- Preserve existing public URLs and frontend contracts through compatibility
  adapters until the frontend has moved to the new contracts.

## Current backend pain points

The existing FastAPI backend is functional but its structure makes the WorkOS
and AI decisions harder to implement safely:

- Auth and authorization are duplicated across `marketplace-api`,
  `booking-api`, and `pms-api`. Each service validates shared JWTs and checks
  `users.type` / `is_superadmin` in slightly different ways.
- Multi-hotel selection relies on `X-Hotel-Id` headers, context variables, and
  fallback-to-first-hotel behavior. This is a compatibility mechanism, not a
  durable organization/resource authorization model.
- Product services directly open other product databases. Examples include PMS
  reading booking-engine hotel identity/payment data, booking-api reading PMS
  billing data, and marketplace-api reading PMS affiliate data.
- Large routers and services mix responsibilities. Current examples include
  `apps/pms-api/app/services/booking_service.py`,
  `apps/pms-api/app/routers/admin_bookings.py`,
  `apps/marketplace-api/app/routers/collaborations.py`, and
  `apps/marketplace-api/app/routers/hotels.py`.
- Side effects such as email sending, Channex ARI pushes, notifications, and
  cancellation handling are often launched inline or fire-and-forget. Failures
  are hard to observe, retry, or link to the originating action.
- The public booking surface is split between booking-api, PMS public room
  endpoints, and PMS booking endpoints. This works for Vayada frontends but is
  not a stable external bookability contract for AI agents or partners.
- Metric definitions and setup-completeness signals are not centralized enough
  for Ask Intelligence to answer with deterministic evidence.

## Target shape

### Deployable apps

Start with one TypeScript backend app and keep deployment boundaries simple:

```text
apps/api
  src/http
  src/domains
  src/jobs
  src/integrations
  src/platform
```

This app can expose route groups for existing products:

```text
/api/marketplace/*
/api/booking/*
/api/pms/*
/api/platform/*
/api/ai/*
```

Product subdomains such as `api.marketplace.localhost`,
`api.booking.localhost`, and `api.pms.localhost` can route to the same backend
app during or after migration. The API boundary should be logical first. Split
into separate deployable services only when there is operational pressure such
as scaling, ownership, compliance, or release isolation.

If the team later wants separate deployables, keep them thin:

```text
apps/marketplace-api-ts
apps/booking-api-ts
apps/pms-api-ts
apps/platform-api-ts
```

Those apps should import the same domain packages rather than copying
authorization, database, jobs, or integration code.

### Shared packages

Recommended shared packages:

```text
packages/backend-config
packages/backend-db
packages/backend-http
packages/backend-auth
packages/backend-authorization
packages/backend-audit
packages/backend-events
packages/backend-observability
packages/backend-test
packages/domain-identity
packages/domain-hotels
packages/domain-booking
packages/domain-pms
packages/domain-marketplace
packages/domain-finance
packages/domain-distribution
packages/domain-intelligence
```

Package responsibilities:

- `backend-config`: environment parsing, secret references, product URLs, and
  runtime feature flags.
- `backend-db`: typed DB clients, transaction helpers, migrations interface,
  advisory locks, read/write connection roles, and test fixtures.
- `backend-http`: request parsing, response envelopes, errors, pagination,
  idempotency, cache headers, CORS, and route registration helpers.
- `backend-auth`: WorkOS session verification, provider identity mapping, and
  webhook ingestion.
- `backend-authorization`: internal organization membership, product
  permissions, resource links, selected organization/resource resolution, and
  policy checks.
- `backend-audit`: product audit events with actor, organization, resource,
  action, before/after, correlation ID, and source.
- `backend-events`: durable domain events/jobs with retries, idempotency keys,
  dead-letter visibility, and typed handlers.
- `backend-observability`: logs, traces, metrics, health/readiness, and
  correlation IDs.
- `backend-test`: builders, fake WorkOS/session contexts, test DB utilities,
  contract fixtures, and HTTP test helpers.

Domain packages should own business language and application services. They
should not import HTTP routers. HTTP adapters import domains, never the reverse.

### Request context

Every authenticated route should receive a resolved context:

```text
RequestContext
  requestId
  actor
    internalUserId
    workosUserId
    email
    status
  selectedOrganization
    organizationId
    workosOrgId
    kind
    membershipId
    roleKey
    permissions
  resources
    hotelGroupIds
    bookingHotelIds
    pmsHotelIds
    marketplaceHotelProfileIds
    creatorProfileIds
    affiliateIds
  locale
  currency
  source
```

The context replaces these old patterns:

- direct `users.type` checks in routers
- `is_superadmin` as the main platform authorization gate
- `X-Hotel-Id` as an authorization primitive
- "first hotel for this user" fallback behavior
- duplicate JWT parsing per product app

`X-Hotel-Id` can remain as a compatibility input during migration, but it must
resolve into a selected organization/resource through
`backend-authorization`. Domain code should not read the header directly.

## Domain modules

### Identity and authorization

Owns:

- internal users
- external identities
- internal organizations
- organization memberships
- organization resource links
- product permissions
- product entitlements
- WorkOS webhook reconciliation
- selected organization/resource resolution

Retire:

- product-specific auth dependency copies
- long-term authorization by email, `users.type`, or `is_superadmin`
- direct user-to-hotel ownership checks scattered through routers

Preserve:

- stable internal user IDs
- existing product resource IDs
- compatibility for current JWT/cookie sessions until WorkOS migration is ready

### Hotels and property content

Owns shared hotel/property facts used by marketplace, booking, PMS, and AI:

- hotel identity, slug, canonical names, previous slug history
- address, geo, timezone, country, descriptions, amenities, images
- branding, supported languages/currencies, social/contact data
- setup completeness and freshness signals
- resource links from hotel groups to product-specific hotel records

This domain should provide canonical read models rather than letting PMS,
booking-api, and marketplace-api keep duplicating hotel identity reads.

### Booking and direct checkout

Owns guest-facing direct-booking behavior:

- public hotel booking profile
- room/rate quote and checkout deep-link generation
- booking request/create flow
- payment authorization/capture coordination
- guest booking lookup/status/cancellation/change requests
- promo/referral/add-on application
- booking idempotency and quote expiration

Preserve:

- existing guest booking status semantics
- current public booking URLs during migration
- Stripe/Xendit/manual payment behavior behind compatibility adapters

Redesign:

- extract quote calculation into a deterministic application service
- separate payment orchestration from booking persistence
- publish booking events for email, Channex, metrics, and affiliate handling

### PMS operations

Owns hotel operations:

- rooms and room types
- rates, seasons, min/max stay, occupancy rates, and availability
- room assignment and room blocks
- admin-created bookings
- check-in/check-out flows
- messaging, notes, financial views, payouts
- Channex ARI and inbound channel-manager sync

Retire:

- one huge `booking_service` as the center of all booking, email, payment,
  Channex, and policy logic
- untracked fire-and-forget side effects

Preserve:

- current PMS DB data model until migrations are scoped and tested
- Channex integration behavior and channel mapping semantics
- existing admin route compatibility while frontends migrate

### Marketplace and collaborations

Owns:

- creators and creator profiles
- marketplace hotel profiles/listings
- collaboration offerings, deliverables, lifecycle, ratings, notifications
- trips and public marketplace browsing
- marketplace admin moderation flows

Redesign:

- move long router logic into application services
- treat PMS/booking facts as read models or domain interfaces rather than
  direct cross-database queries

### Finance, billing, and payouts

Owns:

- product subscription and module entitlements
- platform fees, affiliate commissions, property payouts
- payment provider configuration and account readiness
- payout settings and payout runs

This domain must expose stricter permissions than operational booking summaries.
Ask Intelligence should not read financial/payout data unless the selected
organization membership has explicit finance permissions.

### Distribution and AI bookability

Owns public machine-readable bookability:

- `GET /api/ai/hotels/{slug}` bookability profile
- `GET /api/ai/hotels/{slug}/quote` live quote endpoint
- structured response schema for external agents, partner feeds, and future MCP
- freshness, cache, rate-limit, and typed unavailable reasons
- canonical booking/deep-link URLs

This domain is public read-only and must not expose guest PII, tenant-private
operational data, unpublished rates, internal commissions, or owner-only setup
details.

Without this domain, AI assistants can only discover and link to Vayada hotel
pages. With this domain and checkout deep links, assistants can verify live
availability, price, and policy before sending the guest into a Vayada checkout
flow.

### Intelligence

Owns the authenticated hotel-owner agent from VAY-601:

- Ask API
- agent runtime adapter
- planner/policy layer
- read-only evidence tools
- answer envelope validation
- conversation state and traces
- audit of accessed resources and suggested actions

This is not the same as public AI bookability. Intelligence uses authenticated
organization context and owner permissions. Distribution serves public,
read-only hotel bookability to external agents and search systems.

## Data access model

Keep database ownership explicit during migration:

- A domain owns writes to its authoritative tables.
- Other domains consume either typed application services, read models, or
  events.
- Cross-database reads are allowed only as migration adapters with an expiry
  note and tests.
- New TypeScript code should not introduce new raw cross-product DB pools as the
  default integration pattern.

Recommended migration bridge:

```text
Python FastAPI services
  -> existing DBs and routes

TypeScript backend
  -> new domain services
  -> typed adapters to existing DB tables where needed
  -> compatibility HTTP routes for migrated frontend/public contracts
```

The first TypeScript domains can read existing tables. The goal is not an
immediate schema rewrite. The goal is to move authorization, orchestration,
contracts, and side effects into clear domain boundaries before deeper data
model changes.

## Old shapes to retire, preserve, redesign

Retire:

- duplicated JWT/TOTP/password logic in product APIs after WorkOS migration
- direct product authorization with `users.type` and `is_superadmin`
- `X-Hotel-Id` as hidden global state in domain logic
- product services opening each other's database pools as normal behavior
- large routers that contain business rules and SQL
- fire-and-forget side effects without job identity, retry, or audit
- frontend-only public booking contracts as the external AI/partner contract

Preserve:

- internal Vayada user IDs and product resource IDs
- current guest checkout and booking lifecycle semantics
- existing public booking URLs through redirects or compatibility adapters
- product DB tables until each data migration is explicitly scoped
- Channex, Stripe, Xendit, email, affiliate, and marketplace integration
  behavior while moving orchestration behind typed services
- local portless hostnames and app paths during migration

Redesign:

- authentication/session handling around WorkOS plus internal identity mappings
- organization/resource authorization around explicit memberships and links
- booking quote/creation/payment as separate services with idempotency
- PMS side effects as domain events/jobs
- hotel setup completeness as a shared read model
- analytics/metrics as curated views for Ask Intelligence
- public AI bookability as a first-class distribution API

## First implementation tickets

These are the smallest useful follow-ups after this decision:

1. **Scaffold TypeScript backend app and shared backend packages**
   - Create `apps/api` with health/readiness routes and route-group structure.
   - Add `packages/backend-config`, `backend-http`, `backend-db`, and
     `backend-test`.
   - Validation: build, typecheck, one HTTP test, and local portless route.

2. **Define RequestContext and authorization contract**
   - Add TypeScript types and tests for actor, organization, membership,
     permissions, and linked resources.
   - Include compatibility inputs for current JWT/cookie and `X-Hotel-Id`.
   - Validation: unit tests for allowed/denied hotel resource resolution.

3. **Backfill organization/resource-link schema plan**
   - Draft auth-db migrations for organizations, memberships, external
     identities, and resource links.
   - Include rollback/backfill strategy and mapping from existing hotel,
     creator, affiliate, and platform users.
   - Validation: migration dry-run locally and fixture-based mapping tests.

4. **Implement public AI bookability profile contract**
   - Add a read-only profile endpoint or contract test using existing booking
     hotel data.
   - Return hotel identity, canonical URLs, capabilities, completeness, and
     freshness.
   - Validation: contract tests and no guest/private fields.

5. **Implement quote service contract**
   - Extract a deterministic quote shape for dates, guests, room count, rates,
     policies, payment capabilities, and booking URL.
   - Can initially read existing PMS/booking tables through adapters.
   - Validation: tests for sold out, min/max stay, same-day cutoff, and payment
     not configured.

6. **Define Ask Intelligence evidence catalog**
   - Specify read-only tools and curated metric views for the VAY-601 MVP.
   - Include permission requirements and unavailable-data states.
   - Validation: schema tests for evidence packs and answer envelope fixtures.

7. **Move one side-effect path to jobs/events**
   - Pick a narrow booking side effect, such as email after booking status
     change or Channex ARI push after room block.
   - Add idempotency, retry, dead-letter visibility, and audit correlation.
   - Validation: unit test retry/idempotency behavior and one integration test.

## Open decisions before implementation planning

VAY-603 should resolve these before committing to a full roadmap:

- TypeScript runtime/framework: choose the HTTP framework and whether the first
  deployable is `apps/api` or product-specific TS API apps.
- Database tooling: pick migration and query tooling for TypeScript
  (`node-postgres` plus typed query generation, Prisma, Drizzle, Kysely, or
  another option).
- Job/event infrastructure: choose the first durable job mechanism compatible
  with ECS/local dev.
- WorkOS rollout sequencing: decide whether WorkOS lands before the first TS
  product route or whether the first TS app supports legacy JWT compatibility
  first.
- Source of truth for hotel identity: decide the exact shared hotel/property
  read model and which current table remains authoritative during migration.
- AI provider/runtime: choose the agent runtime and storage shape after the
  evidence tools are defined.
- Public AI terms/rate limits: define external client limits, cache policy, and
  acceptable use for bookability APIs.

## What this enables

This target structure gives VAY-603 a concrete implementation-planning base:

- WorkOS can be introduced through one identity/authorization layer rather than
  three duplicated FastAPI dependency stacks.
- Ask Intelligence can use authorized evidence tools instead of arbitrary SQL or
  prompt-level tenant scoping.
- AI-agent bookability can expose one public quote/bookability contract instead
  of leaking internal booking-api/PMS boundaries.
- Python and TypeScript services can coexist behind compatibility routes while
  migration proceeds domain by domain.
- Backend implementation tickets can be small, testable, and reversible instead
  of broad "rewrite the backend" epics.
