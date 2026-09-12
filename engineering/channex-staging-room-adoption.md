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
