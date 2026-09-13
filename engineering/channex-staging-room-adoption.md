# Scoped Channex catalog adoption (VAY-1981)

The staging import repair needs canonical room/rate mappings for its existing
reservation. A privileged CLI may adopt exactly one already-mapped provider room
and a booking-specific external-rate reference into the already-owned staging property. This is a PMS catalog command,
not property-claim adoption or a booking import.

Preview is the default. Require next runtime, global workers disabled, booking
sync observe-only, an exact configured staging property and staging API URL,
an active property claim/connection, and a VAY approval reference. Fetch the
specified booking revision and Booking.com channel using the scoped credential.
Require a confirmed single-room revision, exact booking/property identity,
non-null room/rate IDs, and the exact OTA room/rate codes in the channel mapping.
Accept a manual per-room rate, or a pure-inheritance derived rate whose parent
is that mapped manual rate. Reject discounts/formulas and ambiguous mappings.

Verify room, rate and optional parent relationships against that property and
room. Copy only bounded catalog facts, never guest data or provider credentials.
Hash the normalized evidence with the binding generation and requested identity.
Apply requires that exact preview hash and refetches all evidence. Under the
property inventory lock, recheck the binding and successful scoped import job,
reject any existing conflicting room/rate mapping or source identity, then
create one canonical room, its room mapping, an immutable staging rate-reference
receipt and an audit event
in one transaction. Concurrent identical applies replay the receipt; replay
checks the mapping and reference identities and never overwrites staff edits. A closed,
inactive, disabled or rebound resource cannot be revived by replay.

The reference table binds the exact property, connection generation, canonical
booking, provider booking/revision, canonical room and provider room/rate. Only
the guarded staging assignment repair may resolve this reference; normal
ingestion still requires canonical room/rate mappings. A reference-backed
assignment leaves its already-nullable canonical rate ID NULL, preserves the
provider rate in `channexStay`, and records the reference ID. This avoids inventing
a PMS pricing plan or converting the booking currency. Provider price/currency
are audit evidence only; canonical room pricing fields remain NULL. Existing
PMS currency constraints and pricing readiness are unchanged.

Adoption does not create physical units, calendar coverage, public availability,
prices, assignments, provider objects or provider writes. Provider room count is
retained only as evidence, not proof of canonical physical capacity. Existing
PMS physical-unit/calendar commands must establish operational readiness before
the unchanged assignment repair can succeed. No jobs are reset or re-ACKed.

An unmapped historical revision remains a provider blocker. Creating a current
channel mapping is not evidence that the acknowledged revision was resolved.
The CLI must not infer that special OTA rate 16385047 equals standard 16385046.

Verify preview has zero writes, exact apply/replay/concurrency, rollback on
conflicts, changed evidence/binding, wrong property/channel/rate, disabled global
guards, missing successful import, and preservation of staff/closure state on
PostgreSQL 16 and 17. Live evidence must distinguish adoption from later capacity,
calendar, assignment and no-show verification.

## Breakfast-inclusive staging evidence (VAY-1981 follow-up)

The existing sanctioned reservation has an unmapped special OTA rate and includes
breakfast. Accept provider `breakfast` alongside `none`/`room_only`; normalize the
latter two to `room_only`. Require a derived rate and its parent to have the same
normalized meal type. Include that meal type in the evidence hash and audit so
a preview cannot authorize a later meal change. Unknown meals remain rejected.
This is catalog evidence only: do not infer a mapping from meal descriptions,
change booked terms, create canonical prices, or bypass the exact historical
revision and OTA mapping requirements. Previous preview hashes must be refreshed. Adoption replay of a pre-change
receipt also rejects its old hash; existing reference resolution for assignment
repair is unchanged. Do not delete or rewrite old receipts to force replay.

## Pre-import bootstrap (VAY-2013)

`adoptChannexStagingCatalog --pre-import` extends this staging compatibility
boundary before a first import. Generic published-offer target ownership remains
VAY-1972/VAY-1549; this reference is never a canonical pricing plan or production
mapping. All existing runtime, claim, binding, provider and approval fences apply.
The preview hash additionally binds a deterministic digest of the authoritative
revision booking facts, including stay occupancy, OTA codes and booked nightly
facts; mutable transport/ACK metadata is excluded. Only the
digest is retained; guest data is not copied into catalog receipts.

A bootstrap reference has no canonical booking yet (`guest_booking_id IS NULL`).
It remains immutable after import. Apply rejects existing canonical bookings
unless replaying its own receipt. It creates one room/mapping, or reuses an exact
active staging-owned room/mapping without editing its facts. Explicit rate
mappings, other identities, inactive/closed rooms and rebound connections reject.
Apply/replay is serialized by the existing inventory and binding locks.

After adoption, an authorized PMS member must complete room facts using the
existing room-facts update command (verified bed/bathroom facts, never inferred
from provider names), then use physical-unit reconciliation,
operating-calendar preview/confirmation and inventory materialization to establish
capacity for the stay. Do not copy provider room count into inventory or fabricate
calendar SQL. Keep public room publication absent and provider stop-sell/zero
availability intact. These are independently audited, replayable prerequisites;
a failed import does not undo their previously committed setup.

The scoped import takes `--catalog-hash` and `--channel-id`, revalidates the
read-only preview against the existing receipt, and checks the pulled revision
digest before persistence. Only this exact scope may resolve an unbound reference.
Normal/global jobs cannot consume it. Its durable key adds `:catalog:<hash>` to
the existing staging-import key, allowing one explicitly approved attempt after
the original mapping failure without resetting that job. A nonterminal original
job rejects; retries/replays reuse the same new key and preserve binding fences.
Booking, assignment, occupancy, booking mapping, nightly evidence and handled
revision/audit commit together. Provider ACK and job completion retain the existing
durable retry boundary: an ACK failure may follow a committed import and retries
must not duplicate it. Catalog receipts and prior failed jobs remain unchanged.

Verify this sequence on PostgreSQL 16/17, including changed facts/generation,
concurrent apply/import, missing capacity, closed/conflicting mappings, normal
consumer rejection, exact OTA nightly evidence and replay. Deployed acceptance
requires a reviewed image and coordinated shared-fixture lease; no provider
objects, reservations, global processing or production behavior change here.

## Retained OTA revision recovery (VAY-2013)

The shared test hotel may be reclaimed after its channel is deleted. Channex
[retains bookings after channel deletion](https://docs.channex.io/channel-api-examples/booking.com)
and supports [catalog probes before connection](https://docs.channex.io/api-v.1-documentation/channel-api).
The explicit `--retained-revision` mode uses those read-only probes plus the
original revision's allocated room/rate. It creates no replacement channel.

This exception is restricted to the exact property, provider booking/revision,
OTA hotel/room/rate and provider room/rate in `retainedRevisionScope`; it requires
`--pre-import`, no `--channel-id`, and a `VAY-2013:` approval reference. Require
`channel_id: null`, `is_crs_revision: false`, an unambiguous standard OTA rate,
a directly owned manual GBP room-only rate, and all existing runtime/binding
guards. Its versioned receipt binds the recovery mode and hotel ID as well as
the existing evidence. Apply refetches that evidence; the scoped import also
checks the retained-revision flags on its final authoritative revision pull.

For the approved target, preview `adoptChannexStagingCatalog` with the existing
property/booking/revision arguments and `--pre-import --retained-revision`;
apply adds `--apply-hash HASH`. After separately establishing verified room
facts and owned capacity/calendar readiness, invoke `importChannexStagingReservation`
with the same scope, `--catalog-hash HASH --retained-revision`. Do not pass a
channel ID. The original failed job, protected bookings, provider stop-sell and
global observe-only guards remain intact. This mode supplies catalog evidence
only; it does not supply missing canonical room facts or authorize production use.
