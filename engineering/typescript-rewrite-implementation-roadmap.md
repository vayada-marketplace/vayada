# TypeScript rewrite implementation roadmap

_VAY-603 roadmap index. Inputs: VAY-600 WorkOS identity architecture, VAY-601
Ask Intelligence architecture, VAY-602 target TypeScript backend structure,
VAY-604 AI-agent bookability, and VAY-605 backend database restructure._

## Purpose

This roadmap explains how Vayada should start the TypeScript backend rewrite
without turning it into one broad implementation epic.

It is intentionally an index, not the full implementation plan. Detailed
contracts, DDL, migration scripts, runtime choices, rollout runbooks, and
product route implementations belong in follow-up tickets and stacked PRs.

## Operating model

- Architecture and contracts come before implementation.
- Prefer stacked PRs with one review question each. Around 400 changed
  non-generated lines is a useful reviewability target, not a hard rule.
- Python FastAPI services remain production source-of-truth until the reviewed
  cutover window.
- New TypeScript code targets the agreed domain model and target-schema
  contracts, not the current product database split.
- WorkOS authentication, Vayada authorization, public AI bookability, and
  authenticated Ask Intelligence are separate concerns even when they share the
  same backend app.

## Phase order

### 0. Guardrails

Goal: make the rewrite process reviewable before implementation starts.

Output:

- shared rewrite workflow skill for agents
- AGENTS.md pointer to stacked PR and architecture-first rules
- PR review expectation for small, single-purpose slices

### 1. Open decision closure

Goal: make the core technology choices explicit.

Decisions to resolve:

- HTTP runtime/framework for `apps/api`
- TypeScript DB query and migration tooling
- target database topology: one physical DB with schemas, or multiple physical
  DBs cut over together
- durable job/event mechanism for ECS and local dev
- WorkOS rollout sequence: same cutover or short-lived legacy session bridge
- initial agent runtime/provider boundary for Ask Intelligence
- public bookability API terms, rate limits, and cache policy

### 2. Core contracts

Goal: define the contracts that product work must use.

Contract slices:

- `RequestContext`: provider identity, internal user, selected organization,
  membership, permissions, linked resources, entitlements, locale, currency,
  and audit metadata
- target schema ownership map for identity, hotel catalog, booking, PMS,
  marketplace, finance, distribution/bookability, Ask Intelligence, jobs, and
  audit: `engineering/target-schema-ownership-map.md`
- migration and parity harness design for target rebuilds, source-to-target
  checks, mismatch reports, and explicit SQL migration application:
  `engineering/migration-parity-harness.md`
- public bookability profile and quote contract:
  `engineering/public-bookability-contract.md`
- Ask Intelligence evidence and answer envelope contract
- jobs/events idempotency, retry, failure visibility, and audit contract

### 3. TypeScript platform scaffold

Goal: create the smallest useful TypeScript backend surface.

Output:

- `apps/api` with health and readiness routes
- route-group structure for marketplace, booking, PMS, platform, and AI
- shared packages for config, HTTP, DB, testing, auth, authorization, audit,
  events, and observability as needed
- build, typecheck, lint, and one HTTP test
- local portless wiring

No product behavior should be ported in this phase.

### 4. Target schema and migration harness

Goal: make target-schema work testable before production data moves.

Output:

- target schema DDL entry points
- local fixture loader
- source-to-target mapping tests for representative records
- row count, uniqueness, checksum, ownership parity, and public/private exposure
  checks where practical
- mismatch reports that are actionable in staging rehearsals

### 5. Domain implementation slices

Goal: implement one domain capability at a time behind contracts.

Recommended first domains:

- identity and authorization resource resolution
- public bookability profile
- quote contract parity
- Ask Intelligence read-only evidence catalog
- one jobs/events side-effect path
- compatibility adapters for existing frontend/public HTTP shapes

Each slice should include contract tests or parity fixtures before product route
coverage expands.

### 6. Staging rehearsals

Goal: prove the target schema, migration pipeline, compatibility routes, and
validation gates work together before production.

Output:

- rebuild target schema from production-like snapshots in staging
- run migration and parity harness
- run API and browser smoke tests against the TypeScript backend where routed
- document go/no-go gates and owner assignments
- record rollback decision points

### 7. Production cutover

Goal: switch traffic only after rehearsals pass.

Output:

- reviewed maintenance window or write-freeze/queue plan
- backup snapshots and legacy DB retention plan
- final migration command sequence
- validation gate checklist
- deploy order for TypeScript backend, frontend config, and compatibility routes
- rollback instructions while the rollback window is open
- post-cutover monitoring and cleanup tickets

## Dependency order

| Before                             | After                                |
| ---------------------------------- | ------------------------------------ |
| Runtime and DB tooling decision    | `apps/api` scaffold                  |
| RequestContext contract            | authenticated product routes         |
| Target schema ownership map        | DDL and migration scripts            |
| Bookability profile/quote contract | public AI bookability implementation |
| Ask Intelligence evidence contract | Ask Intelligence MVP implementation  |
| Jobs/events contract               | side-effect migration                |
| Migration/parity harness           | staging rehearsal                    |
| Staging rehearsal pass             | production cutover                   |

## First follow-up tickets

These should be created as separate Linear tickets with concrete acceptance
criteria:

1. **Choose TypeScript backend runtime and DB tooling**
   - Decide framework, query tool, migration tool, and test harness.
   - Validation: decision record with tradeoffs and scaffold implications.

2. **Define RequestContext contract**
   - Model actor, organization, memberships, permissions, linked resources,
     entitlements, locale, currency, and audit metadata.
   - Validation: allowed/denied fixture cases for hotel, creator, affiliate,
     and platform scopes.

3. **Define target schema ownership map**
   - Convert the VAY-605 domain ownership plan into table-level ownership and
     source mapping.
   - Validation: every current migration history is represented or explicitly
     deferred.
   - Output: `engineering/target-schema-ownership-map.md`.

4. **Design migration/parity harness**
   - Specify local/staging commands, fixture shape, count checks, mismatch
     reports, and go/no-go failures.
   - Validation: harness design explains how ambiguous ownership and public PII
     leaks fail.
   - Output: `engineering/migration-parity-harness.md`.

5. **Scaffold `apps/api`**
   - Add health/readiness, route groups, minimal shared packages, build,
     typecheck, one HTTP test, and portless wiring.
   - Validation: local build/typecheck/test passes; no product route behavior.

6. **Define public bookability profile and quote contract**
   - Specify public-safe hotel profile, quote request/response, freshness,
     unavailable reasons, and booking deep-link context.
   - Validation: fixtures for bookable, sold out, payment disabled, min/max
     stay, same-day cutoff, promo/referral, and stale data cases.
   - Output: `engineering/public-bookability-contract.md` and
     `engineering/fixtures/public-bookability/cases.json`.

7. **Define Ask Intelligence evidence contract**
   - Specify read-only evidence tools, answer envelope, unavailable-data states,
     audit records, and tenant scope rules.
   - Validation: fixture answers reference evidence and cannot cross tenant
     scope.

8. **Write cutover and rollback runbook**
   - Define coexistence, staging rehearsal gates, maintenance window,
     deployment order, rollback window, and post-cutover monitoring.
   - Validation: tabletop review with explicit go/no-go gates.

## References

- `engineering/workos-identity-architecture.md`
- `engineering/ask-intelligence-architecture.md`
- `engineering/ai-agent-bookability.md`
- `engineering/typescript-backend-structure.md`
- `engineering/backend-database-restructure.md`
- `engineering/target-schema-ownership-map.md`
- `engineering/migration-parity-harness.md`
- `engineering/public-bookability-contract.md`
- `.agents/skills/typescript-rewrite-workflow/SKILL.md`
