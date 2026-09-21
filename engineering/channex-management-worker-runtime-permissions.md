# Channex management worker database boundary (VAY-2041)

## Decision

Keep `TARGET_DATABASE_URL` on the restricted general API role. A Channex
management worker needs a separate, non-owner credential for its job and offer
state transitions. Do not give the general role blanket `UPDATE` on
`platform.jobs` or broad PMS write grants merely to complete a staging smoke.
The worker credential is for the existing Channex management queue and PMS
Channex state, regardless of which OTA a hotel later maps through Channex; it
must not encode Booking.com, Airbnb, Expedia, or any other OTA as a database
permission category.

This document is the boundary contract, not a grant list. The full transitive
SQL inventory and a database-enforced shared-queue mechanism must be reviewed
before any credential is provisioned or worker flag enabled. Application
`WHERE` clauses and a staging-property environment variable are necessary
runtime guards but are not database privilege boundaries.

## Current failure and deployment state

VAY-2036's first deployed selected-offer command failed before acceptance with
PostgreSQL `42501` on `platform.jobs`; no target, job, or Channex provider write
was made. A protected owner-only grant now permits the general API role to
`INSERT` into `platform.jobs`, and its read-only privilege preflight passes.
The exact VAY-2036 image is deployed to the Channex staging canary, with the
management worker flag off. Independently, PR #2554 gates a scoped ARI source
scheduler that had continued running while that worker was paused. The new
command-side grant does not grant the job claim, receipt, reconciliation, or
completion writes required by the worker.

## Connection ownership

| Consumer | Credential | Rule |
| --- | --- | --- |
| Authenticated PMS selected-offer command and read APIs | `TARGET_DATABASE_URL` | May enqueue only through existing authenticated, property-scoped command path. |
| Channex management worker store, provider plans, offer dispatch and reconciliation, availability helpers, and scoped ARI scheduler | Dedicated Channex worker URL | Required only when the management runtime is explicitly enabled; no fallback to the general or migration-owner URL. |
| Migration runner | `TARGET_DATABASE_MIGRATION_URL` child process | Never inherited by the long-lived API or worker. |

The initial implementation must inventory every `apps/api/src/server.ts`
consumer connected to `channexManagementPlans`,
`channexManagementWorkerStore`, `channexUploadReconciliationPool`, and
`channexOfferSchedule`; splitting only the job store while the provider pool
still uses `TARGET_DATABASE_URL` is incomplete. This inventory must also follow
the availability ports into `pmsOperatingCalendarRuntime.inventory`, its
separate pool, and every authorization/evidence dependency it calls. Either
route those calls through the worker credential or define and verify an
intentional read-only port boundary. A selected-offer worker test must prove
that it opens no undeclared database credential. A paused canary must not open
the worker credential or start its scanner, claim loop, or provider dispatcher.
Use a management-specific activation condition for the credential and all
management schedulers/dispatchers; enabling unrelated Channex workers must not
open this boundary.
If the worker remains in the API process, the dedicated credential is still
visible to that process; this split limits its database authority but is not
a process-isolation claim.

## Permission inventory to complete before grants

The following direct writes are present in the current call graph. This is
an inventory, not blanket permission approval; SQL functions, triggers, and
transitive helper calls must be added before the matrix is complete.

| Path | Direct write families to review |
| --- | --- |
| `pmsChannexManagementWorkerStore.ts` | `platform.jobs` claim/lease/continuation/completion; `platform.job_attempts`; failure `platform.dead_letter_events`; idempotency and product audit. Row locks on jobs and `hotel_catalog.properties` also require privileges. |
| `replacementPricingOfferOwners.ts` and receipt helpers | `pms.channex_offer_targets`, target intents and versions, creation/ARI attempts and receipts; retained outcomes and replay reconciliation. |
| `channexRoomAvailability*` and closed-upload helpers | Availability attempts/receipts, closed ARI receipts and pending reconciliation; verify every one-use dispatch and readback table. |
| `pmsChannexManagementTargetState.ts` | Connection/sync status and mapping transitions, including failure paths. Limit this path to operations actually enabled for the selected-offer worker. |
| `pmsChannexAriSchedule.ts` and `pms.enqueue_restriction_ari` | Scheduled-source upsert and Channex management job enqueue; verify function invoker rights and trigger effects. |

`platform.jobs`, attempts, dead letters, audit, and idempotency are shared
across product domains. The worker must be unable to claim, update, finish, or
dead-letter another queue's job even if a query is malformed or injected. The
implementation may use a reviewed row-level policy, queue-specific write
surface, or validated transition functions. It must prove the chosen boundary
with real restricted-role PostgreSQL 16 and 17 tests; do not rely solely on
application SQL predicates. The staging canary must additionally be limited to
its existing test property through both deployment configuration and verified
database behavior before provider mutation is allowed.

The worker role must be non-superuser, non-owner, have `rolbypassrls = false`,
and have no effective membership in an owner, migration, `BYPASSRLS`, or other
privileged role. If row-level security is selected, the contract must define
table-owner behavior and whether `FORCE ROW LEVEL SECURITY` is required, and
its negative tests must connect through the exact deployed login path rather
than a substitute fixture role.

## Rollout and evidence gates

Migration 0407 supplies the shared-queue foundation for the fixed login
`vayada_next_channex_management_worker`. Its owner-managed property allowlist
starts empty. Restrictive policies limit jobs to selected-offer provisioning
and ARI, correlate attempts/dead letters/audits to visible jobs, and correlate
management idempotency keys by property and job key hash. Recovery, booking,
meal, and inventory-rule commands remain outside this initial boundary.
Existing identity policies remain permissive and unchanged; the worker adds
no permissive bypass on those shared tables. The lookup helper is an invoker
function that returns before accessing worker-only tables for other callers.
Owners retain migration authority; a future worker must neither own tables nor
bypass RLS. This migration creates no login or grants and does not complete the
PMS/source permission matrix, role preflight, provisioning, or deployment gates.
The later column grants must keep job identity fields immutable to the worker:
no UPDATE on queue/property/payload/hash, and no INSERT on the idempotency hash.
Only the authenticated command path may establish that hash correlation;
worker-created scheduler jobs do not supply one.

1. Complete the transitive SQL/trigger inventory and choose one database
   mechanism for shared queue and property scoping. Review the exact table,
   column, function, and sequence matrix and negative cases first.
2. Land application credential routing and protected, non-owner role/secret
   provisioning in small PRs. Add a worker-role preflight that rejects owner,
   migration/evidence, identity, booking, finance, marketplace, unrelated PMS,
   and cross-queue writes. Preserve the general runtime preflight.
3. Apply grants through a reviewed, bounded owner-only runner. Verify the
   actual ECS task definition's secret references and immutable image digest;
   testing an independently supplied URL does not verify deployed wiring.
   Keep the canary worker paused through this step.
4. Coordinate a new exclusive fixture window. Enable only the staging URL and
   test property, execute one selected published-offer command, and verify its
   durable original creation receipt, closed-first ARI, reconciliation, and
   provider readback. Do not retry an ambiguous provider outcome or repeat
   the preserved VAY-1545 closed rate/upload. Keep bookings, payments, and
   global production provider processing out of this smoke.

VAY-2036 stays In Progress until this deployed smoke passes or records a new
precise blocker. Source evidence and fixture preservation rules are in the
local shared Channex test record and VAY-2041 issue.
