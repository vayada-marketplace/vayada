# Affiliate earning and settlement contract

VAY-1510 / VAY-1501. Accepted product rules, 2026-09-11.
After presentation of the six-rule summary and the detailed proposal, the user
answered "ok porceed" to "Do you want to adopt this set?". This records the accepted
product behavior; it does not activate publication, earning processing or payments.

Read with [percentage policy](affiliate-percentage-policy.md),
[booking evidence](affiliate-booking-evidence-contract.md) and
[creator agreements](marketplace-affiliate-agreements.md). Finance owns calculation,
adjustments and payout state. Booking/PMS supplies authenticated evidence through
its existing boundary; Marketplace supplies exact accepted agreement references.

## Accepted rules

| Area | Rule |
| --- | --- |
| Completed stays | Apply the hotel's exact accepted percentage to accommodation revenue actually collected and retained after accommodation discounts/refunds. Exclude taxes and extras. |
| Cancellation/no-show | No commission for an unconsumed cancelled or no-show stay, even when a penalty is retained. |
| Partial refunds | Only the accommodation portion reduces commission; refunded taxes or extras do not. Full accommodation refunds reduce final commission to zero. |
| Refund after payout | Preserve paid history and record a linked adjustment against future earnings from that same hotel. |
| Payment timing | Require a 14-day hold and verified evidence before eligibility; pay monthly once funded and ready for transfer. |
| Payer/fees | Hotel funds commission. Do not silently deduct a fee from the creator's displayed percentage. |

No default percentage is introduced. Changing the hotel's rate does not recalculate
an agreement's historical earnings under a newer policy version.

## Amount and evidence semantics

An accommodation subtotal after discounts/refunds is already net of those changes:
do not subtract them again. A gross booking total cannot substitute for classified
accommodation revenue. Missing or uncertain allocation stays pending/review, never
zero by default. Cumulative refund snapshots are not incremental refund transactions.

Determine eligibility at canonical stay-item scope. A booking group can contain
completed, cancelled and no-show items; a group label cannot qualify unconsumed items
or erase valid completed items. Early departure requires evidenced consumed
accommodation and explicit allocation of any unused-night refund or penalty. Do not
count both the group total and its constituent items. Replacement bookings retain
reconciled attribution lineage and must not create duplicate earning opportunities.

Each calculation must preserve hotel, creator, agreement, accepted policy version,
currency, canonical booking/item and supporting evidence references. Payment alone,
a scheduled departure date or a claimed referral does not establish eligibility.
Refund contradictions, overlapping items and invalidated completion require review.

## Eligibility is separate from payment

Verified attribution, exact accepted terms, completed-item evidence and sufficiently
classified collected accommodation revenue are prerequisites in addition to the
14-day hold. An unresolved dispute affecting the earning prevents its release.
Missing evidence cannot become sufficient merely because the hold elapsed.

After eligibility, hotel funding and a supported verified creator payout destination
are separate transfer prerequisites. Funding/account blockers must remain visible;
an unfunded earning is not erased or labelled paid. Monthly initiation is not a
promise of immediate bank arrival. Later refunds remain possible after any hold.

## Adjustments and audit

For a correction, calculate the revised earning total and record the difference
from the previously calculated total. Preserve every paid entry and its transfer
reference. An adjustment is not a new payout instruction. Replayed observations and
commands cannot duplicate commission, adjustments or transfers.

Offsets remain scoped to the same creator and hotel, with compatible currency.
Insufficient future earnings or an ended partnership leaves an outstanding adjustment
for review. No automatic bank debit, collection action or cross-hotel offset follows
from acceptance of these product rules. Recovery wording and provider capabilities
still require their own completion before launch.

## Implementation details still to finalize

The accepted summary fixes a 14-day hold and monthly funded payout. The linked
proposal recommends the following precise mechanics; retain them as proposed
implementation details until their owning contract is finalized:

- Hold starts at the first durably accepted authenticated completion evidence for
  the exact item, using a recorded instant rather than inventing physical checkout.
  Duplicate delivery does not reset it; late imports are not backdated.
- Monthly initiation on the 15th at 00:00 UTC, with an explicit readiness cutoff.
- No additional Vayada minimum balance; provider minimums shown explicitly.
- Same-currency settlement without automatic FX, using Finance-owned currency
  precision; round half-up once per canonical item and derive corrections from
  revised totals rather than independently rounding every refund.

Hotel-facing platform/transfer pricing, recovery disclosures, supported payout
currencies and provider restrictions are not silently selected here. These details
must not be treated as already deployed behavior or filled with hidden defaults.

## Acceptance scenarios

With an explicitly accepted 10% rate and EUR evidence:

| Facts | Final commission |
| --- | --- |
| Completed, collected EUR500 accommodation + EUR50 tax + EUR100 extras | EUR50 |
| EUR500 accommodation less EUR50 accommodation discount | EUR45 |
| EUR500 accommodation less EUR100 accommodation refund | EUR40 |
| EUR500 accommodation, EUR50 spa-only refund | EUR50 |
| Cancelled/no-show item with EUR100 retained penalty | EUR0 |
| EUR50 commission paid, later EUR100 accommodation refund | EUR50 payment preserved, EUR-10 adjustment, EUR40 final earning |

Also verify incomplete allocation stays pending; partial groups do not overlap;
replayed refund snapshots produce one adjustment; exact historical policies survive
new rates; unfunded eligible balances remain visible; and disputed earnings cannot
enter a payout batch. No runtime tests are claimed by this document.

## Delivery boundary

The next Finance slice should define and test the deterministic item-level amount
calculation against explicit evidence and policy references. Keep it separate from
provider collection, agreement activation and payout execution. Finalize currency
precision/rounding and the hold clock in that owning contract before implementing
those respective operations. Durable evidence and adjustment processing follow.

The existing publication command must remain blocked until actual complete
creator-visible commercial disclosures and validated tracking evidence are available.
Product-policy acceptance does not satisfy its evidence prerequisites. No schema,
route, Finance balance, provider setting or payout changes in this contract slice.
