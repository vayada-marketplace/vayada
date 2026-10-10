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

- **Cohort hotels** migrate as today, plus the setup rows native onboarding writes (see
  [Setup completeness](#setup-completeness)).
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

**Phased waves** (Flamur, 2026-10-10). The migration runs in waves; each wave
is one source run whose cohort is that wave's hotels. A run has three classes
of hotel:

- **cohort:** the wave's hotels, migrated as above;
- **earlier waves' hotels:** already migrated by an earlier run. The run must
  leave them untouched: no re-quarantine and no disabled auto-open row
  (later-wave design, below);
- **non-cohort:** every other legacy hotel, including the later waves'
  hotels. They import as non-cohort while they keep trading on legacy.

The non-cohort state above is the target's copy only: stopping legacy for a
wave's hotels is the runbook's per-hotel legacy freeze.

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
  - Legacy `scheduled` and `processing` payouts of non-cohort hotels are retired
    in the target, not kept actionable. Legacy keeps paying out the hotels still
    on legacy, and finishes payouts it already started for a migrated hotel.
  - Channex adoption ignores `outside_migration_cohort` quarantine. It no longer
    treats it as a warning that blocks all adoption.

## Setup completeness

A carried cohort hotel (inside the cohort and not in private quarantine) leaves the PMS import in
the state native onboarding leaves a property in, measured by the VAY-2066 readiness criteria.
Runs without a cohort, hotels outside it and quarantined hotels get none of this.

- **Pricing settings** (criterion f): `pms.property_pricing_settings` in the native first-currency
  shape, with the currency of the operating room types. An ambiguous or natively unsupported
  currency writes no row; a stored row with another currency blocks.
- **Room labels** (criterion c): the legacy room number becomes a verified operational label for
  operating rooms whose printable-ASCII label is unique case-insensitively in the property. This
  replaces the 0048 rule that migrated labels stay unverified, for cohort hotels only. A twin stays
  unverified, so the property stays in setup.
- **Room facts**: a cohort room type takes the native room-facts columns (`occupancy_limits`
  total/adults/children; `room_attributes` beds, bedrooms, bathrooms, bathroom type, size; the
  category key), mapped as the PMS room form maps its fields; the legacy copies move under
  `room_attributes.legacyRoomFacts`. The runtime's room-facts reads (rooms, operating calendar,
  inventory) fail for the whole property on the legacy shape. Legacy records no bathroom type:
  `private` (the form's default), or `shared` without a bathroom count. A room type without a bed
  type or with limits the native contract refuses keeps the legacy shape; parity fails for an
  active one (`cohortRoomFacts`), so fix it in legacy before the extraction.
- **Operating calendar** (criteria d and e): revision 1 of `pms.operating_calendar_revisions`, as
  the native calendar save writes it: the legacy operating periods its room types share as the
  recurring schedule (year-round without periods), minimum stay 1, the owner organization, the
  catalog profile revision and canonical time zone, and one binding per operating room type at its
  physical capacity. Room types with different operating periods get no calendar: the schedule is
  the property's. Periods are read day by day as legacy reads them (unvalidated `MM-DD` strings);
  a recurring schedule has no 29 February of its own, so a period open only then gives no
  calendar; inside the imported coverage 29 February stays closed where legacy closes it, and
  later native days follow the schedule. The import also writes the idempotency key, domain event
  and outbox row its foreign keys require, and its audit row, with the migration as actor. A hotel gets no calendar
  without one owner organization, a canonical time zone or a known legacy owner user, or when an
  operating room type has no native room facts, no rooms, or rooms that differ from its inventory
  total. A rerun keeps the stored migrated revision 1 as it is, also after later native revisions,
  and blocks when it no longer carries it; a revision 1 the migration did not write blocks where
  the import would plan one.
- **Inventory coverage**: for a hotel with that calendar, the imported days of each bound room
  type take the canonical shape native materialization writes at calendar revision 1, in the
  calendar's time zone, and `pms.inventory_materialization_coverage` covers them, with its
  idempotency key, projection refresh event and outbox row, and audit row. They run from the
  snapshot day for a year (only to a fixed auto-open window's month end), and always through the
  last day a legacy booking, draft or block holds, so later extensions never meet a day without
  its consumers. The status follows the calendar's schedule; other days legacy does not sell at
  the snapshot (priced at 0, inside the minimum advance or past the same-day cutoff on the
  calendar's clock, closed by legacy operating periods on a day the schedule opens such as 29
  February, over capacity, or past the legacy auto-open window) become a manual sellable limit of
  0, which the VAY-2066 job keeps when it rewrites generated counts and the rate gate. Within the
  year a rolling window is not a closure (the producer moves it by the same month-end rule); a
  day covered only for a booking or block past both the year and the legacy window stays closed
  until someone lifts the manual limit, in both modes. Unbound (inactive) room types of such a
  hotel keep no imported days, and parity expects each bound type's coverage, or more days once
  the native jobs extend it. A hotel blocks the run (`COHORT_INVENTORY_NOT_CARRIED`) when its
  coverage would pass the auto-open worker's 762-day maximum (a live legacy booking, draft or
  block far out), when an unbound room type still holds a live booking, draft, block or stored
  inventory day in it, or when a bound room type has stored days past it: native setup could not
  replace such legacy-shaped days later, so fix the legacy data before the extraction. A live
  booking draft anywhere in a calendared hotel's coverage blocks as before
  (`ACTIVE_BOOKING_DRAFT`).

A hotel that misses an item stays `provisioning`. One without a calendar keeps legacy-shaped
inventory days, which the native calendar save and materializer refuse to adopt, so fix its
calendar prerequisites before the extraction rather than after the import.

**Activation.** At the end of the PMS import, after every setup row is written and verified, a
carried cohort property whose profile is `complete` and that meets every VAY-2066 readiness item
(a–g, evaluated on the target) becomes `lifecycle_status = 'active'`, as the native lifecycle
command activates one (lifecycle revision + 1, its idempotency key and audit row; `updated_at` is
kept so the catalog reconciliation keeps comparing the migrated profile). A complete profile is
the native one: `complete` with no completeness reasons. The carried cohort property rows are
locked `FOR NO KEY UPDATE` before their setup rows are written (other properties' rows rely on
the table locks), which serializes with the native settings writers and lifecycle commands. A
hotel that misses an item stays `provisioning`; suspended or retired ones are never touched.
Parity fails an active carried cohort property that is not ready and a ready one that is still
`provisioning`, and always reports the counts and what the provisioning ones miss.

**PMS modules.** Legacy `pms.property_module_activations` of a carried cohort hotel map to the
runtime's property-scoped `module:*` entitlements; only `financials` has one. Active legacy
modules without one are reported as unmapped, including `affiliates`: its changes are retired
(410), but the module read and booking-admin's Refer-a-guest setting still read
`module:affiliates`, so such hotels lose that setting (open decision). The identity import's
legacy-shaped `financials` rows on `pms_hotel` stay as they are; the runtime does not read them.
After the setup rows are verified and before activation, the import writes a missing module as
native onboarding leaves it: the seven starter expense categories, the entitlement marked as the
completed first-currency default (`newHotelFinancialsDefault = ready` with this transaction) and
its `pms.financials.default_activated` audit row. A module legacy had off, or had no row for
(legacy reads that as off), is then switched off as the Feature Hub does: `suspended` with the
`featureHubOwnerDisabled` marker of this transaction, so the Owner can switch it on; never the
0449 hotel-setup marker. The marker is live while it equals the row's `xmin`, as for native
hotels: a logical restore, a blue/green switch or any later write of the row ends it, and the
Owner can then no longer switch the module on. Its audit row is
`pms.financials.owner_off_imported`, because the 0449 trigger rejects (or, in a hotel-setup
session, applies) `financials_module_deactivated` from a superuser or hotel-setup role member.
A hotel gets no module, and the PMS report and parity (`COHORT_MODULES_REPORTED`) list it as
skipped with the reason, without one
active `hotel_group` owning both native links (the native default and the Feature Hub need the
owner; an operator does not qualify), an active base PMS entitlement of that organization with
no suspended one (`property-management`, `pms-core`, `account_access`), no organization-wide
Financials entitlement, pricing settings in a first currency, or with an archived starter
category. A stored module is never rewritten: one that differs from legacy (an Owner or
operator change after the import, or a row the Owner can no longer switch) is kept and reported
as preserved with its status, ready default and Owner-off state.

## Channex handover (P12, import side)

A cohort run imports **no** Channex connection live. Without this, every `mutating` next-api
Channex switch would act on every imported `connected` hotel at once, and the 0128 binding
trigger would infer an active `migration` claim for each one. The per-hotel promotion belongs to
VAY-2108; this is the state it starts from and the rules it must keep.

**What the import leaves**, for a cohort hotel whose legacy connection was active, with a Channex
property ID and an active owner, at the snapshot:

- `pms.channel_connections`: `connection_status = 'disconnected'`, `external_property_id` null,
  `capabilities = '{}'`, `messaging_app_installed = false`. `connection_metadata` keeps
  `migrationRunId`, `migrationCohortRunId` (the cohort's `source_run_id`, on every cohort hotel's
  Channex connection and on no other), `channexHandover = 'pending'`, `legacyExternalPropertyId`,
  `legacyCapabilities`, `ownerStatus = 'active'`, `retainedClaimState = null`, the legacy ARI
  error and the channel markups. The `last_*_sync_at` timestamps and the historical
  `channel_sync_status` receipts stay as legacy wrote them.
- No `pms.channel_binding_claims` row for the property or for its Channex property ID.
- Room-type and rate-plan mappings `disabled`; `mapping_metadata.sourceActive` and
  `roomTypeActive` keep the legacy flags. Booking mappings `ignored`, with their `assignment_id`.

A cohort hotel whose legacy connection was off, or whose owner is not active in the target, keeps
today's `historical` claim with the same disconnected, null-ID connection (case V). VAY-2017 can
never take it live (0432 requires an active legacy source), and the VAY-2108 handover handles
only the pending case: so the VAY-2017 owner bootstrap runs before the import, and a case-V hotel
does no Channex handover. Without a cohort nothing changes.

`disconnected` is the inactive value every target reader excludes and the one the promotion paths
start from. Webhook intake, booking persistence and the Channex scheduler need `connected`; ARI,
management commands, messaging and the iframe need `connected` or `degraded`; the pricing
authority and superseded-offer intent also accept `setup_incomplete`. Readers keyed by property
rely on that status filter; readers keyed by the Channex property ID find a null one; webhook
resolution also accepts an active claim alone, and there is none. So no switch flip (booking sync,
webhook intake, ARI, manual booking sync) makes an imported hotel live. `enable` is refused for a
legacy-sourced property without a claim by #2961, which is on `main` and must be in the deployed
image (this stack predates it). The VAY-1964 adoption consumer requires exactly this no-claim
state (`BINDING_CLAIM_HISTORY_EXISTS` otherwise).

The import blocks (`TARGET_UNIQUE_CONFLICT`) when another connection holds the legacy Channex ID
or a claim exists for the property or that ID (other than the hotel's own promoted active claim
on a re-run), and when a later snapshot would replace a pending or completed handover with a
historical claim (for example one taken after the F.7 legacy disable: restore `is_active` for
the snapshot instead).

**What the promotion must do**, per hotel at its H.2, after the legacy disable (F.7) and H.1:

1. Check the start state above: `channexHandover = 'pending'`, `migrationCohortRunId` naming a
   stored `platform.production_migration_cohorts` row that lists the hotel, the connection
   `disconnected` with a null ID, and no claim for either key.
2. In one transaction, claim first, then the binding:
   - write the `(property, 'channex', legacyExternalPropertyId)` claim as `active` (direct
     activation; nothing in the repo activates a claim today). An active claim alone already
     makes webhook intake resolve the hotel, so it never commits without the binding;
   - set `external_property_id = legacyExternalPropertyId`, `connection_status = 'connected'`
     (the legacy ARI error stays history in the metadata), `capabilities = legacyCapabilities`,
     `messaging_app_installed` when they include `message`, and `channexHandover = 'completed'`,
     keeping `migrationCohortRunId`;
   - set room-type and rate-plan mappings `active` where `sourceActive` and `roomTypeActive`
     hold and the room type is still active, and booking mappings `active` where
     `assignment_id` is set.
3. Bump `updated_at` on every row it changes.

Constraints: only this promotion sets `external_property_id`. The import, its re-runs and resumes
plan the same null ID (a re-run writes nothing; a changed legacy row updates the connection with
the ID still null). Any writer that sets the ID while no claim matches (a re-run, a repair or
manual SQL) makes the 0128 trigger insert an active `migration` claim on its own, because the
connection metadata carries a `vay1351-` run ID: hence claim first, then the ID. Parity fails a
cohort connection that is reachable (status, Channex ID, messaging, an active mapping or claim)
until `channexHandover = 'completed'` and an active claim hold its ID. A promoted row with a newer
`updated_at` is preserved by any later import. One whose `updated_at` did not move blocks a re-run
of the same source (`TARGET_PROVENANCE_MISMATCH`), and a changed source would **overwrite** it
back to pending with its active claim left behind, so step 3 is mandatory. The management worker
cannot do this: it may insert only `enable` claims and bind only with one. Never `enable`, never
`disable` (it deletes the Channex property).

Later waves (W2.2): in a later run an earlier wave's hotels count as outside the cohort, so its
outside checks (`connectedChannel`, `bindingClaim`, `activeChannexMapping`) flag handed-over
hotels, and a still-pending earlier-wave row would be rewritten as outside (dropping its stamp and
marker). The later-wave path must exempt earlier waves first.

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
- It also fails when an active room type of a cohort property lacks native room facts, and when
  an `active` cohort property misses a readiness item (a–g) or a complete profile. Its summary
  counts the cohort's `active` and `provisioning` properties and what the provisioning ones miss.
- It also checks calendar auto-open rows, given that a property without one is
  on by default (VAY-2066 R2). A cohort PMS property whose legacy auto-open is on
  needs a matching enabled row, one whose legacy auto-open is off needs none,
  and a non-cohort one needs an explicitly disabled row.
- Unit tests per domain cover cohort, non-cohort and no-cohort behaviour.
  PostgreSQL integration tests cover the cohort table, the snapshot load and
  the parity invariant.

## Related constraints

- The VAY-2017 owner bootstrap planner currently requires exactly eight owners
  (`legacyOwnerBootstrapPlan.ts`). It must take the approved cohort of each
  wave instead; wave 1 has three hotels, so this is a wave-1 prerequisite.
- **Later waves.** A later wave's hotels were imported as non-cohort (private
  quarantine) by every earlier run. The import refuses to change an existing
  disposition (`CATALOG_SOURCE_DISPOSITION_CONFLICT`), and the identity import
  refuses earlier users and quarantined resources (`USER_EQUAL_TIME_CONFLICT`,
  `QUARANTINE_RESOURCE_CONFLICT`), by design. Wave 2 therefore needs a reviewed
  later-wave path: promote those hotels to cohort (catalog disposition, owner
  group, links, entitlements), refresh their rows from the new source run,
  handle a hotel that was a cohort hotel once and was handed back to legacy,
  and leave earlier waves' hotels untouched. It is a wave-2 prerequisite, not
  a wave-1 one.
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
