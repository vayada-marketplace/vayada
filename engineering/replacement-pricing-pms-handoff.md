# Replacement pricing → Vayada PMS handoff (VAY-1543)

Status: implementation contract and code audit; no consumer or public activation.
Extends [replacement acceptance](replacement-booking-acceptance.md) and the
[PMS reservation boundary](pms-reservation-integration-contract.md).

## Verified gap

The pricing stack at `5d0e495c6` and fetched `origin/main` at
`21623e7e8fa8f12a163ad78073d6db4847e88453` contain producers of
`pms-reservation-handoff` jobs but no runnable consumer/registration for them.
`bookingWebPublic.ts::enqueuePmsReservationHandoff` and
`stripeBookingSettlement.ts` publish legacy `selectedOffer` as `bookedOffer`.
`server.ts` registers other workers, not this queue. The portable
`packages/pms-vayada-adapter` has no production repository/caller here and rejects
mixed room selections. Its comment previously claimed a transactional consumer
existed; that claim was not supported by this checkout.

Manual booking and Channex import paths create operational assignments, but are
not direct-booking handoff consumers. VAY-644's fake-sink service and VAY-645's
portable adapter completion do not prove runtime queue consumption. Preserve those
historical ticket scopes; do not describe their tests as end-to-end handoff evidence.

A second blocker is migration0170's `pms.adopt_direct_booking_inventory_receipt`.
It derives `inventory_quote` from `inventoryQuoteSessionId` or `quote_session_id`.
Replacement bookings intentionally leave the legacy FK null, while
`reservePmsQuoteInventory` binds holds to the replacement quote UUID string.
The trigger's complete-bundle query therefore cannot match those receipts today.
Populating the retired FK or trusting posted `pricingQuoteId` is not a repair.

## Ownership and implementation order

| Slice | Concrete owner/boundary | Required outcome |
| --- | --- | --- |
| 1. Replacement receipt binding | PMS-owned migration and PostgreSQL tests | Derive the replacement quote from immutable scoped acceptance, retain all bundle adoption guards. |
| 2. Accepted-room projection | Booking-owned accepted-history reader → typed PMS port | Exact per-selection identity and existing hold evidence, no legacy offer reconstruction. |
| 3. Transactional adoption | PMS repository under its property inventory lock | Complete operational assignment set and hold adoption atomically; exact replay or conflict. |
| 4. Producer and consumer | Booking stages job; API worker delegates to PMS port | Durable reference job, lease-safe execution, retries/audit and registration. |
| 5. Full acceptance composition | VAY-1543 Booking writer | Stage job with booking/receipt/history/notifications, then final quote/Finance gate and commit. |

Booking does not insert PMS assignments or recalculate capacity directly. PMS owns
assignment, receipt lifecycle, occupied/linked inventory reconciliation and ARI
side effects. No provider/Channex call belongs inside Booking acceptance.

## Repair receipt adoption first

Add an explicit replacement branch to the existing adoption guard. It must find
exactly one `booking.pricing_quote_acceptances` row by the booking/property and
bind its organization, quote ID, immutable quote, inventory bundle and complete
selected-room list. Verify the current booking's unchanged dates, room count,
metadata quote reference and bundle against that evidence. Initial replacement
adoption supports confirmed, edit-revision-zero bookings only.

Use the accepted `pricing_quote_id::text` as receipt quote correlation. Do not
read today's rate plans or use metadata alone as quote/receipt authority. Preserve
the legacy initial and accepted-amendment branches for legacy bookings. A changed
replacement booking cannot fall through into the legacy branch. Replacement
amendment adoption needs its own accepted amendment evidence before it is enabled.

Retain existing property, dates, unique receipt/type, complete count, per-type
assignment count, explicit per-assignment receipt membership, terminal-state,
released-block and replay checks. Check the final assignment set using the existing
deferred trigger mechanism. All assignment writes and receipt state transitions
roll back together. Never make a partial bundle valid by omitting a room type.

## Accepted-room projection and adoption

The Booking reader loads stored acceptance and its completed receipt under scoped
job identity, reusing the historical decoder/replay linkage checks. It does not
revalidate today's quote prices, expiry or guest choices after acceptance. The
worker has a server-authorized job scope, not a guest's public slug authorization.
Scope checks must establish the recorded organization/property and local PMS
ownership; an ownership/provider change blocks for reconciliation rather than
rerouting the booking to another PMS.

The PMS port receives acceptance/booking/quote/property/organization identity,
check-in/out, the recorded PMS bundle, and one ordered room entry for every
`quote.stay.rooms` selection. Keep `selectionId`, 1-based physical position,
`roomTypeId`, opaque `offerId`, adults and exact child ages. Multiple selections
of one room type remain separate positions. Do not multiply the first room's
amounts or treat a pricing offer ID as a PMS rate-plan UUID.

PMS resolves each receipt through its own repository and matches property, quote
correlation, dates and room-type counts. Never infer receipt/type binding merely
from array positions. The complete accepted bundle must match all held room types.
Each assignment stores its own matching lifecycle receipt and acceptance/selection
provenance. Use `source=direct_booking`, `stay_evidence_kind=exact`, and pending
room-type assignments with no fabricated physical room. Preserve actual child ages
in evidence; do not rewrite them using a later hotel's age threshold. A verified
rate-plan binding may populate `rate_plan_id`; otherwise retain the opaque offer
identity in provenance with no invented mapping. Room labels come from the scoped
catalogue if needed, never from a fake `selectedOffer`.

The initial adoption port rejects conflicting/partial existing assignments. An
identical already-adopted complete set replays without duplicating capacity,
assignments, events or holds. Reuse existing receipt adoption and reconciliation;
do not reserve inventory again or apply an additional room-count decrement.
Cancellation/release or edits before execution must not revive the original stay:
record a visible terminal conflict and leave lifecycle resolution with its owner.

## Job contract and runtime

Keep the existing queue, but use an explicit new job type
`pms.reservation.accepted-pricing.create` so a replacement reference is never
interpreted as a legacy `pms.reservation.create` payload. The versioned payload
contains only `version=booking.pricing-pms-handoff.v1`, `propertyId`,
`guestBookingId` and `acceptanceId`; read authoritative evidence by those references.
Use deterministic key `pms:pricing-acceptance:<acceptanceId>:create:v1` and verify
property/resource/payload identity on replay. No guest PII or duplicate price
snapshot is needed in the job. Do not silently consume or relabel legacy jobs.

Stage this job on the original acceptance connection before the final deadline
gate. It becomes visible to workers only with a complete commit. Workers claim
bounded batches with leases/attempt limits using existing platform job patterns.
During execution, take the property inventory lock before booking/receipt locks,
then validate the still-current lease and source evidence before mutations. Adopt
the full set, reconcile inventory and record job completion/audit in one transaction.
A stale lease cannot publish success. Retry only retryable failures; retain a
visible terminal outcome for invalid/missing/conflicting evidence. Register the
consumer with `backgroundWorkersEnabled`, bounded polling and shutdown cleanup.

## Required proof before activation

- Real PostgreSQL replacement-quote adoption with mixed types, multiple rooms of
  one type and child ages; no legacy quote-session or selected-offer fabrication.
- Wrong property/organization/quote, missing/duplicate/extra receipt, wrong dates
  and partial assignments reject; legacy initial/amended guard regressions pass.
- Failure after any assignment or receipt transition rolls everything back;
  identical replay does not decrement inventory or enqueue ARI twice.
- Committed job consumption creates the expected operational assignments and
  hands off holds without a capacity gap or double count. Rollback hides the job.
- Duplicate workers, lease loss, cancellation/edit-before-consumption, retry after
  failure and registration/shutdown exercise real consumer behavior.
- Full Booking acceptance retains original price/consent evidence and passes its
  final deadline gate; a queued job alone is not completed PMS adoption.
