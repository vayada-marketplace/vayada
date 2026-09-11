# Affiliate accommodation revenue evidence

VAY-1510 / VAY-1511. Implementation design for the accepted percentage basis in
[earning and settlement](affiliate-earning-settlement.md). This document maps
existing sources and defines the next producer boundary; it adds no runtime behavior.
Read with [booking evidence](affiliate-booking-evidence-contract.md) and
[earning journal](affiliate-earning-journal.md).

## Findings from the current TypeScript sources

| Source                                                                                                               | Evidence available                                                                                                                      | Affiliate limitation                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Quote producer](../apps/api/src/routes/bookingWebPublic.ts), `createTargetCheckoutQuote`                            | Saved room total, taxes/fees, extras, discounts, promotions and selected offer; mixed quotes also carry room lines and promo allocation | A quote is a price, not collection. Fields must be interpreted according to the producing version. A current quote can replace an earlier one.                                            |
| [Native nightly producer](../apps/api/src/domains/stripeBookingSettlement.ts), `captureDirectNightlyRevenueEvidence` | Night, room position, room type, source revision and corrections                                                                        | `grossRoomAmount` does not establish collected, retained accommodation net of every discount/refund. Occupancy counters are not verified completion.                                      |
| [External nightly producer](../apps/api/src/domains/bookingExternalNightlyRevenueEvidence.ts)                        | Scoped manual/OTA evidence, quality, revision, correction and refund links                                                              | `exact` describes the supplied nightly amount; it does not certify tax treatment or payment allocation.                                                                                   |
| [Manual payment writer](../apps/api/src/domains/financeManualPaymentSettlement.ts)                                   | Canonical payment, booking, amount, fee, net amount, currency and command metadata                                                      | `netAmount = amount - feeAmount`; this is not the affiliate accommodation base. Its balance query also includes authorized/pending statuses and must not be reused as collected evidence. |
| [Manual full-settlement writer](../apps/api/src/domains/financeManualBookingSettlement.ts)                           | A Finance-owned full payment tied to manual booking creation evidence                                                                   | Booking-wide collection alone does not identify accommodation components or canonical item allocation.                                                                                    |
| [Manual refund writer](../apps/api/src/domains/bookingPmsManualRefundNightlyRevenueEvidence.ts)                      | Explicit refunds allocated to nightly evidence, coupled to a Finance refund port in the transaction                                     | Reuse these references. They still need component classification and canonical item mapping before becoming affiliate accommodation refunds.                                              |
| [Payment schema](../packages/backend-migration/migrations/0007_finance.sql), `finance.payments`                      | Payment states, gross/fee/net/refunded amounts, booking and provider references                                                         | No typed canonical stay-item/component allocation in this table. A cumulative refunded amount must not be counted again as separate refund rows.                                          |

The reviewed sources are partial inputs, not an end-to-end revenue resolver. Do not
backfill trustworthy affiliate amounts from field names, JSON labels, booking status
or a provider's advertised capability. No existing payment or revenue evidence is deleted.

## Ownership and minimum input

Booking supplies the accepted charge composition and amendments for the exact
canonical booking and stay item. PMS/external adapters supply equivalent authenticated
observations through Booking's boundary. Finance supplies collection, refund and
dispute evidence through its owning port. Marketplace must not read their tables to
assemble money. The Finance resolver combines these owner results before passing
`netAccommodationMinor` to the existing calculator.

Each owner result identifies property, canonical booking/item, currency, source
connection/environment, producer contract version, source revision and immutable
evidence references. Do not map `linePosition` to a stay-item ID by assumption: retain
the owning domain's exact mapping and its revision, including replacement lineage.
No guest identity matching, inferred room assignment or cross-hotel fallback.

Charge composition distinguishes accommodation, tax, extras, penalties and unresolved
components. Each amount states whether discounts are already included. Preserve
explicit component allocations for promotions/refunds; do not subtract a net discount
twice. Combined `taxesAndFees` must be interpreted by its producer contract, not
silently split or classified as accommodation. Unknown inclusions remain unresolved.

Finance collection evidence must distinguish confirmed receipt from authorization,
pending processing and a request to collect. An authenticated manual-payment record
is identified as a hotel-recorded receipt, not provider-confirmed bank settlement.
Evidence must show which charge/item was paid and which source revision it concerns.
An expired quote, payment request, zero balance display or booking `paid` flag alone
is insufficient. Provider fees remain separate; do not substitute payment net proceeds
for the accepted accommodation basis or introduce a new fee deduction here.

## Resolution rules

1. Verify exact scope, source version, currency and item mapping. Missing provenance
   stays pending; contradictory mappings, duplicate economic events or incompatible
   revisions require review. Diagnostic probes cannot produce live earning inputs.
2. Resolve charge composition from the accepted booking/amendment evidence, not a
   mutable current catalogue or an unrelated current quote. Preserve the original
   booking opportunity and the ordered corrections to its charges.
3. Resolve confirmed collection and explicit allocation. For a fully paid booking,
   allocation may be derived only if the complete accepted component/item breakdown
   reconciles exactly to the confirmed collections and all adjustments. This is a
   supported producer-specific rule to implement and test, not a default inference
   from `payment_status`. Partial or ambiguous collection has no automatic prorating,
   accommodation-first or extras-first rule in this design.
4. Apply only evidenced accommodation refunds to the collected accommodation amount.
   Reconcile cumulative snapshots and transaction histories using source identities;
   never sum both. A refund without a known component/item allocation stays pending.
   Impossible totals, duplicate allocations or a refund exceeding its reconciled
   source require review. Do not clamp contradictions to zero.
5. Return the resulting nonnegative accommodation amount, already net of its discounts
   and refunds, in explicit currency minor units. Conversion must be exact under the
   Finance currency contract; unsupported precision stays pending, with no implicit FX
   or new rounding policy. Keep source references with the amount.

Stay completion, cancellation/no-show treatment, creator attribution, agreement
acceptance and payout eligibility remain separate checks. A retained cancellation
penalty is classified separately and cannot become consumed accommodation. A disputed
collection must not be emitted as unqualified verified retained revenue; unresolved
dispute state must block release even if a calculation is retained for history.

## Read result and revision consistency

The proposed owner boundary returns `pending`, `needs_review` or `recorded`:

- Pending names the missing charge classification, item mapping, confirmed collection,
  refund allocation or supported currency semantics. Missing does not mean zero.
- Review names contradictory scope, amount, duplicate event or revision evidence.
- Recorded carries exact scope, `netAccommodationMinor`, currency precision, component
  and collection/refund evidence references, and the coherent source revision.

These are revenue-evidence states, not the journal's calculated/paid states. The
resolver must recheck current authorization before exposing protected evidence or
replaying a command. Owners must supply a coherent revision set: freeze immutable
source references or recheck a revision fence before journal append. Do not combine
a newer refund with an older payment/charge snapshot. A digest of such mixed rows
would not make them coherent. Later corrections produce a new source revision and
reuse the journal's idempotent recalculation and adjustment history.

## Required examples

All amounts below are EUR; the 10% rate is an explicit test policy, not a default.
Completed-stay and accepted-agreement evidence are assumed only for the commission
column. Source records must prove the stated facts.

| Facts                                                            | Accommodation evidence                    | Commission                  |
| ---------------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| Fully collected: room 500, tax 50, extras 100                    | 500                                       | 50                          |
| Same composition; payment fee 20, payment net 630                | 500, not 630 or 480                       | 50                          |
| Room 500 with room-only discount 50; fully collected total 600   | 450                                       | 45                          |
| Already-net room 450 includes that discount                      | 450, no second subtraction                | 45                          |
| Collected deposit 100 against total 650; no component allocation | Pending                                   | Pending                     |
| Accommodation refund 100 from collected room 500                 | 400                                       | 40                          |
| Spa-only refund 50, room still collected 500                     | 500                                       | 50                          |
| Unallocated refund 50 from mixed booking                         | Pending                                   | Pending                     |
| Same refund reported as cumulative snapshot and transaction      | One refund, after identity reconciliation | One adjustment              |
| Two items share a room type; only one consumed                   | Exact per-item mapping required           | Completion checked per item |
| Unconsumed cancellation with retained penalty 100                | Penalty excluded from accommodation       | 0 under cancellation rule   |
| Authorized payment only, even with booking marked paid           | Pending                                   | Pending                     |

## Next implementation slices

1. Booking: define and test normalized charge composition from the native accepted
   price producer. Start with an explicitly bounded supported case; reject ambiguous
   mixed allocations/tax semantics. Preserve a versioned immutable source reference
   and item mapping, adding storage only where the existing source cannot supply it.
2. Finance: expose confirmed collection/refund evidence from existing writers and
   their audit. Implement exact full-payment reconciliation for that same supported
   case. Preserve unsupported/partial cases as pending, not guessed amounts.
3. Compose the owner results into the revenue resolver; test source revisions,
   concurrent refunds, duplicate delivery and diagnostic exclusion with real producer
   persistence. Then connect it alongside accepted agreements, attribution and
   completion to the existing journal. No synthetic proofs in the production resolver.

This sequence requires no new payment provider or generic accounting framework.
External adapters use the same evidence semantics but must prove their own mappings.
Partial-payment allocation policy, unsupported tax treatment and any provider-fee
deduction remain unresolved rather than being selected by implementation.

## First bounded price component implementation

`classifyAffiliateRoomPrice` reuses `createBookingPriceSnapshotInput` and its real
versioned calculator instead of interpreting legacy quote totals. The existing
factory requires matching mandatory-charge confirmation and explicit-zero taxes/fees.
The first supported case is one room with no applied additional-guest charge; other
item allocations/classifications remain pending. Seasonal/weekend room prices and
any supported selected-rate discount are already included in the final price.

The immutable result retains the complete producer snapshot and uses
`accommodationPriceMinor`, not Finance's `netAccommodationMinor`. It does not claim
that extras are absent, that the booking accepted this price, or that any amount was
collected. Canonical booking/item acceptance binding and complete charge composition
remain required before collection reconciliation. No checkout caller, persistence,
public route or journal integration is added by this pure component.

## Original native checkout charge storage

Migration 0186 preserves the actual native checkout quote totals and selected offer
in `booking.original_charge_snapshots`, scoped to the original booking/property/quote
and request. It is written for non-draft creation in the booking statement and outer transaction;
replay does not append another row and checkout failure rolls it back. Updates,
deletes and truncation are rejected. Later current-quote changes cannot rewrite it.
Existing bookings are not backfilled from their mutable current quotes.

This is `native-checkout-charge.v1` with mandatory `unclassified` status. It is not
the versioned price factory's output and cannot be passed as classified accommodation.
A guest submitting a booking request does not prove hotel acceptance or payment.
Amendment history, accepted-price/item mapping, classification and collection remain
required; this original snapshot alone must not determine a later earning amount.
There is no evidence-read route or Finance caller in this storage slice.

Card checkout initially creates a deletable draft. This slice excludes drafts so
existing abandoned-draft cleanup can still delete them and release inventory.
Capturing card price evidence at its later accepted transition remains unsupported;
do not infer an original snapshot from a later mutable quote or treat absence as zero.
