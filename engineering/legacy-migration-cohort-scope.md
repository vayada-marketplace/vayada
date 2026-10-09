# Legacy migration cohort scope (VAY-1362)

_Contract, 2026-10-08. Implements the scope decision in
[`legacy-migration-go-day-runbook.md`](legacy-migration-go-day-runbook.md):
only an approved cohort of legacy hotels becomes live in the target. Code
follows in separate PRs; this document is the reviewed contract they implement._

## Problem

The production domain migrations in `packages/backend-migration` turn **every**
legacy `booking.booking_hotels` row into a canonical target property:

- Owner organizations, memberships and entitlements are created for all of them.
- A hotel goes public when its legacy status is `live` and its owner is public-eligible.

There is no per-hotel switch. Migrating ~200 legacy hotels to go-live a handful
would publish hotels nobody approved, grant owner access nobody reviewed, and
create name and slug duplicates of native properties.

## Rule

A **cohort** is an approved, immutable list of legacy hotel IDs for one source
run.

- **Cohort hotels** migrate exactly as today.
- **Non-cohort hotels** still import **every** row, so the full-row extraction,
  checksum and parity accounting is unchanged. Each one lands in a state that is:
  1. **Private.** The profile is `private`. There is no verified custom domain,
     no public media, offer, add-on or creator-visible Marketplace listing, and
     no public bookability.
  2. **Without access.** There is no active organization membership, owner
     resource link or entitlement. Users whose only ownership is non-cohort get
     no access path; the default is `suspended`. An owner of both kinds of
     hotels gets access to the cohort hotels only.
  3. **Inert.** No `connected` channel connection, no active Channex mapping, no
     enabled provider (Stripe/Xendit) account, no scheduled or processing payout
     left actionable, and no jobs.
- **No cohort row for a run** means behaviour is exactly as today. This keeps
  staging rehearsals and existing tests valid.

## Input

A new insert-only target table, written once per source run by the
orchestrator before the identity step:

```text
platform.production_migration_cohorts(
  source_run_id        text primary key,   -- vay1351-…
  cohort_sha256        text not null,      -- canonical JSON of the ID sets
  booking_hotel_ids    uuid[] not null,
  pms_hotel_ids        uuid[] not null,
  marketplace_hotel_ids uuid[] not null,
  approval_proof_sha256 text not null,
  created_at           timestamptz not null default now()
)
```

- All three ID sets are listed explicitly; none is derived from another. A
  catalog group whose Booking, PMS and Marketplace members disagree on cohort
  membership is a blocker (`COHORT_MEMBERSHIP_MISMATCH`). The check fails closed.
- `readProductionIdentitySnapshot` loads the row in the same validated run
  read, so every domain, every parity dry run and Channex adoption see the same
  cohort.
- `target:cutover*` gains `--cohort <reviewed cohort.json>`.
  `cohort_sha256` is part of the orchestration `configSha256`, of the parity
  checksum material and of the production approval artifact. A resumed run
  cannot change it.
- A cohort ID that is absent from the attested source is a blocker
  (`COHORT_HOTEL_NOT_IN_SOURCE`).
- A second, different cohort for the same source run is a blocker
  (`COHORT_CONFLICT`).

## Disposition

- **Catalog.** Non-cohort Booking anchors become `private_quarantine` with the
  new reason `outside_migration_cohort`. They keep `propertyId = sourceId`, so
  other domains still resolve their rows. PMS and Marketplace rows attached to
  such an anchor take the anchor's ID with the same disposition.
  Today `privatePropertyId()` applies only to unresolvable PMS and Marketplace
  rows.
- **Identity.** Non-cohort owner groups take the existing quarantine path:
  archived organization, archived links, no membership. Archived links already
  make Booking, Finance, PMS, Marketplace and Media resolve to their inactive
  states.
- **Cohort access.** Catalog completion gives each cohort property the native
  access hotel setup creates: active `(hotel_catalog, property)` and
  `(pms, pms_property)` links in the one active hotel organization owning its
  legacy links, and an active PMS `property-management` entitlement scoped to
  that property. Runtime tenancy (VAY-1543) and Channex adoption require them.
- **Hardening.** The existing quarantine path does not cover these yet:
  - The custom domains of private groups are not verified.
  - The core writer archives the `booking_hotel` link and the `booking-engine`
    entitlement as well.
  - The Booking and Finance owner maps respect the disposition, not only the
    owner-link status. This mirrors PMS's archived context.
  - Legacy `scheduled` and `processing` payouts of non-cohort hotels are retired,
    not kept actionable.
  - Channex adoption ignores `outside_migration_cohort` quarantine. It no longer
    treats it as a warning that blocks all adoption.

## Verification

- A new parity invariant `COHORT_SCOPE_VERIFIED` fails (no-go) when any
  non-cohort property has any of:
  - a non-`private` profile
  - an active owner link or membership path
  - a `connected` channel connection or an active Channex mapping
  - an enabled provider account
  - public media, offers or add-ons
  - a verified domain
- It also fails when a cohort property is unexpectedly quarantined, or lacks
  exactly one active hotel organization holding both native links with an
  active, unsuspended PMS entitlement.
- It also fails when a cohort PMS property lacks a calendar auto-open settings
  row matching its legacy choice (enabled or disabled), or a non-cohort one
  lacks an explicitly disabled row. Auto-open is on by default without a row.
- Unit tests per domain cover cohort, non-cohort and no-cohort behaviour.
  PostgreSQL integration tests cover the cohort table, the snapshot load and
  the parity invariant.

## Related constraints

- The VAY-2017 owner bootstrap planner currently requires exactly eight owners
  (`legacyOwnerBootstrapPlan.ts`). It must take the approved cohort instead.
- Historical binding claims are written only for cohort hotels. A
  legacy-sourced property without a binding cannot enable Channex (VAY-1362 6c guard).
- No RLS policies or triggers are added on identity or catalog tables. The
  hotel-setup preflights pin their digests. The new table lives in `platform`.

## Implementation order (stacked PRs)

1. Cohort table, `--cohort` input, snapshot load, config and parity checksum
   binding. The no-cohort path is unchanged.
2. Identity quarantine for non-cohort owners.
3. Catalog disposition plus presentation and writer hardening.
4. Booking, Finance, PMS, Marketplace and Media hardening, payouts, and the
   Channex adoption exemption.
5. The `COHORT_SCOPE_VERIFIED` parity invariant.
