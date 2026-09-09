# Supported room closure and retirement

VAY-910 follow-up, authorized 2026-09-09. This contract covers one existing room
in the TypeScript next-environment target schema, in a property with at least
one other operational room. It does not authorize
production activation, whole-property closure, or direct repair of fixture data.
See [backend ownership](typescript-backend-structure.md) and the existing
`pmsPhysicalRoomInventory.ts` and room-type retirement guards.

## Problem and decision

A materialized room cannot retire its last physical unit while the operating
calendar binds it. Removing only that binding is invalid: current calendar
validation expects every active room, and later authoring can add the room back.
Ordinary retirement also correctly blocks active inventory, publication and
channel mappings. Disabling mappings alone cannot resolve these dependencies.

Introduce an explicit, durable **closing** state owned by PMS, separate from
`room_types.active`. Closing is a terminal operating-eligibility decision on the
path to retirement; it does not mean the canonical room has already retired.
Historical room facts, rates, bookings, inventory, calendar revisions and public
content revisions remain stored. No implicit reopening or deletion is supported.

The state transition is `operating -> closing -> retired`. An immutable closure
receipt records the command, selected room, accepted source revisions and local
cutoff date. Existing ordinary DELETE protections remain applicable to the final
transition. A closing room is operationally ineligible even while its canonical
active flag remains true and its channel mappings await confirmed closure.

## Supported command and concurrency contract

A protected PMS room-scoped closure command accepts property/room IDs, expected
room facts and units revisions, expected calendar revision, expected active
publication revision, and an idempotency key. It uses existing PMS manage policy,
property/organization ownership and entitlements. The request cannot provide
SQL, arbitrary targets, a synthetic-only guard exemption, or a replacement hotel
schedule. A read-only impact response identifies affected units, future dates,
publication and mappings so the operation is reviewable.

Reject a stale expected revision, last remaining operational room, missing or
inconsistent coverage, active reservation/hold/operational assignment, linked
inventory membership, active room block, protected manual/channel allocation,
unknown source owner, or conflicting closure command. Recheck these under the
same locks as the write. A booking that acquires inventory first blocks closure;
a closure that acquires it first prevents subsequent reservation. Do not cancel
bookings, release holds, erase overrides or edit other room state automatically.

Acquire property inventory, then property room-facts, then physical-unit locks
for sorted room IDs, then the `booking.publication` advisory lock. Expose
transaction-bound PMS closure and Distribution offer-suppression/eligibility
ports sharing this client; do not call standalone repositories that open their
own transactions. Competing activation paths must recheck eligibility while
holding the publication lock. No path may acquire inventory after publication. A single shared database transaction must:

1. Reserve idempotency and establish the immutable closing receipt/fence.
2. Close only the selected room's future inventory from the property-local
   accepted date. Closure, impact and final retirement must share that explicit
   timezone-derived cutoff: `stay_date >= cutoff_date` is inclusive; rows with
   `stay_date < cutoff_date` are historical. Use that predicate in all three
   operations (replace the retirement query's implicit CURRENT_DATE
   in this flow); do not mix server UTC and property-local dates. Preserve its historical rows and existing owner counters;
   assigned/blocked counts must already be zero. Retire only its eligible units
   through PMS-owned lifecycle logic, retaining IDs and history.
3. Append the next immutable calendar revision with the same schedule, timezone,
   policy and other room bindings; omit only the closing room. Advance necessary
   calendar/materialization metadata for remaining covered rows without changing
   their available/assigned/blocked values, pricing or manual/channel/booking
   source ownership. Preserve stored coverage_from/through and validate the complete
   retained horizon before publishing new coverage counts. Remaining room rows
   across that horizon advance calendar_revision/generated_source_revision and
   inventory_revision exactly once; no booking/manual/channel/block/linked
   source revision or counter changes. Past rows of the closing room remain
   historical and are excluded from the new coverage set; future rows remain
   stored and closed. Do not reuse the unit helper's coverage truncation.
4. Invoke Distribution's transaction port to suppress only this room's public
   offers. Establish the current operating-eligibility fence for active-content
   reads and quote/reservation acceptance. Do not fabricate a new `ready`
   manifest or mutate an immutable published revision.
5. Persist audit and durable owner-domain refresh/closure intents. In the initial
   already-closed staging flow these are Distribution/owner refresh events, not
   Channex management jobs or ARI/provisioning enqueue triggers. Require fresh
   provider-owner closed-zero evidence independently; do not claim that an
   unsent closure intent proves provider acknowledgement. The command must not
   enqueue work that its paused zero-queue mapping transition cannot settle.
   Unsupported connected modes fail closed until a separate delivery protocol
   exists; never delete jobs or resume an open-capable worker to drain them. Commit the
   receipt and all database changes together. Any failure rolls all of them back.

A same-key replay returns its own recorded result without reapplying changes.
Different payload with the same key fails. Stale calendar authoring,
materialization, publication projection and retry jobs must reject/observe the
closing fence; they cannot republish, reopen inventory, add units or rebind the
room. The fence is enforced at the durable mutation boundary, not only in UI or
an initial read. No general invariant may be relaxed for the fixture.

## Owning-domain effects and intermediate states

PMS exposes operating eligibility as a typed owner read/transaction port. Calendar
room evidence, inventory materialization/auto-open, physical-unit writes and
room-scoped inventory/booking commands consume it. Room facts remain truthful:
`active=true` does not override `closing` operating eligibility. Every eligibility
consumer and writer must be enumerated in the implementation review.

Distribution consumes the same eligibility evidence when serving current public
content and producing offers. During projection lag, unrelated room content and
availability remain usable while the closing room is absent/unavailable. Old
quote identifiers do not bypass current eligibility and inventory checks. The
normal publication owner builds and activates a successor using current source
snapshots and real readiness evidence. Removing the room/plan changes the PMS
pricing fingerprint: first use supported pricing-source read, then mandatory
charge confirmation using current revision/fingerprint and the preserved choices,
then guest-policy refresh/readiness with the same policy choices. Only then
request publication. Never copy or invent a ready manifest. The close result
reports `publication_refresh_required` until that owner sequence succeeds;
replay reports the recorded phase rather than claiming final retirement.
Current-content filtering is immediate and retains unrelated published rooms
while these explicit supported refresh steps settle. Old immutable revisions remain unchanged.
A replay/projector built before closure must not reactivate the excluded room.

Channex mappings stay active during closing until provider closure is confirmed.
The Channex owner must ensure ARI/meal work for a closing room can only preserve
closure, never emit open inventory or create/re-enable a mapping. Existing queued
or leased work must be fenced and drained **before closure commits**, not only
before map disable. A precomputed open payload must not be sent after closure.
The initial supported connected-staging flow requires verified worker pause and
zero pending/running jobs before closure, retained through provider closure
readback and mapping transition. It rejects unsupported connected-worker modes;
no general online provider lease protocol is claimed by this slice. Workers
must consume the closing fence before they can later resume. A provider
acknowledgement/readback must follow the final pre-closure send; a database
check before an in-flight network request is insufficient. The general product path
requires provider closure acknowledgement before disabling mapped identities;
no database transaction pretends a provider write succeeded.

For this already authorized staging fixture, keep the provider room/rate closed
without any OTA-channel binding. The two canonical-to-provider mappings remain
active through closing, provider acknowledgement and readback; only the later
exact-two-row operation disables them. OTA bindings and these identity mappings
are different relationships. After the pre-closure pause and supported closure/publication prerequisites
are satisfied, the separately reviewed exact-two-row maintenance operation may
verify fresh closed-zero provider evidence, acquire the exclusive fixture lease,
retain the already verified pause of the actual current image, reconfirm no
pending/running management work, and disable only the two new mappings with an audit receipt.
This maintenance path is not a public product mapping API or a general provider
closure implementation. Preserve original mappings, connection and binding claim.

## Final retirement

Once closing has settled, the ordinary supported retirement-impact must report
no active reservations/holds, units, future open inventory, blocks/linked groups,
active channel mappings, public offers or active-content references for the room.
Only then soft-retire it with fresh revision/idempotency checks. The closing fence
and receipt survive retirement so delayed jobs and replay cannot resurrect it.
Canonical flexible pricing and canceled booking history remain retained. A room
that is already retired without this command's receipt returns `room_type_not_found`; clients must not
treat it as successful idempotent replay.

## Required evidence and implementation slices

1. Review this lifecycle/ownership contract and exact mutation/read consumer map.
2. Add the durable closure state and typed PMS eligibility/command contract with
   forward-only migration and meaningful PostgreSQL constraints/concurrency tests.
3. Implement PMS closure/calendar/unit orchestration and Distribution eligibility
   integration through owning ports, with atomic rollback, stale/replay and
   concurrent booking/materialization/publication tests. Keep each reviewed PR
   focused and around 400 non-generated lines; dependent slices remain gated until
   the complete closure boundary is deployed together.
4. Add protected command/impact routes and denial-matrix tests. Wire durable
   post-commit work with retries, audit correlation and fail-closed stale inputs.
5. Exercise the supported deployed path only after a fresh coordinated lease and
   verified current image. Compare the original room's inventory/owner revisions,
   schedule, eight original reservations, two season rules and provider fixtures
   before/after. Retire only the VAY-910-created room and leave provider records
   closed. Keep the completed mixed-room evidence and activation #1705 unchanged.

The deployed regression fixture is room09bb6503-2e79-4ac4-8124-75fa8619da1d,
plan a0f24612-e948-4d89-a327-cc6f3830a54a. Its last verified baseline has two rooms
and 732 covered days at calendar7/materialized7, all three test bookings canceled,
eight original reservations unchanged, and zero management jobs. These values
are historical evidence, not a future execution gate; refresh before writes.

### Initial consumer inventory (must be verified against implementation)

| Boundary | Existing code | Required closure behavior |
| --- | --- | --- |
| Calendar evidence | `pmsOperatingCalendarReadModel.ts`, `pmsOperatingCalendarCommandRepository.ts` | Compare/bind operationally eligible rooms; reject a stale pre-closure authoring snapshot. |
| Materialization and auto-open | `pmsInventoryMaterializationRepository.ts`, `pmsCalendarAutoOpenWorker.ts` | Never insert/reopen the closing room; validate retained complete horizon and current eligible membership. |
| Unit/facts changes | `pmsPhysicalRoomInventory.ts`, `pmsPhysicalRoomManagementRepository.ts`, `pmsRoomFactsCommandRepository.ts` | Existing active-room guards remain; closing additionally rejects capacity additions/reopening and stale unit reconciliation. |
| Inventory writers | `pmsInventoryReservationLifecycleRepository.ts`, `pmsInventoryReservation.ts`, `pmsOccupiedInventory.ts`, `pmsLinkedInventoryReconciler.ts`, `pmsOperationsCommandRepository.ts` | Serialize with closure; reservation/inventory/linked commands cannot increase future sellability or assignments after closure. Release/history paths remain valid. |
| PMS publication snapshots | `pmsRoomPublicationReadModel.ts`, `pmsBookingPublicationSource.ts`, `pmsBookingPublicationContent.ts` | Preserve full private facts/history; public owner snapshots consistently exclude closing rooms and matching rates. |
| Active content serving | `routes/activeBookingPublicationProfile.ts` and its consumers | Apply current owner eligibility, including historical active revision served while refresh is pending; preserve unrelated content. |
| Publication activation | `bookingPublicationProjector.ts`, `distributionBookingPublicationProjection.ts` | Revalidate current eligibility under publication coordination lock before activating captured content; reject pre-closure results. |
| Channel jobs | `pmsChannexManagementWorkerStore.ts`, provider planning and target-state adapters | Coordinate leased/pending jobs; no open ARI, meal provisioning or mapping reactivation for closing rooms. Retain closure delivery path. |
| Final retirement | `pmsOperationsCommandRepository.ts` | Require existing dependency guards plus own closure evidence when using the new flow; preserve historical canonical flexible plan. |

This table is a review checklist, not proof that those integrations exist. The
contract cannot be marked implemented on the basis of a migration or one route.

### Runtime scope

This is a target-schema `apps/api` change. Legacy Python
`RoomTypeRepository.list_by_hotel_id`, `admin_room_types.delete_room_type`,
`ChannexConnectionRepository.upsert/deactivate` and `provision_property` use the
legacy PMS model/database and are not alternate writers of this target fixture.
Do not connect those paths to the target database or staging connection as part
of this change. Any future compatibility bridge must preserve the same fence.
Within `apps/api`, include connection-level enable/disable and provisioning in
the Channex consumer review: enabling must not recreate or reactivate mappings
for closing rooms; room closure must not disable the property connection or
unrelated room/rate mappings. Unsupported connected modes remain rejected.
