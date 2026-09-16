# Connecting owner evidence to the affiliate earning journal

VAY-1511; proposed integration contract following merged #1932. This specifies the
missing producers and their join; it adds no resolver, route, payment or commercial
rule. Read with [earning rules](affiliate-earning-settlement.md),
[journal](affiliate-earning-journal.md), [booking evidence](affiliate-booking-evidence-contract.md)
and [outcome reads](affiliate-earning-outcome-read.md).

## Verified starting point

Audit baseline: main `57b0551dde5645f48a98314a32b8d1867c20c427`, 15 September 2026.
Finance can normalize bounded evidence, calculate a total/correction and record an
immutable outcome once per canonical source revision. The runtime evidence resolver
is absent. A stored offer draft, payment or checkout alone cannot fill its contract.

| Owner/source already present                                                          | What it proves                                                                                          | Missing before earning use                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketplace draft revisions (`0173_marketplace_affiliate_offer_terms_drafts.sql`)     | Exact saved policy, destination and window                                                              | Immutable publication plus creator-specific hotel approval and creator acceptance of that same version                                            |
| Finance percentage policy versions (`0180_finance_affiliate_percentage_policies.sql`) | Exact hotel-approved rate component                                                                     | The creator's accepted agreement; rate approval is not creator assent                                                                             |
| Existing collaboration assent in `marketplaceCollaborations.ts`                       | Current negotiated collaboration state                                                                  | Historical immutable affiliate terms and independent agreement lifecycle; mutable assent timestamps are insufficient                              |
| `readPmsAffiliateCompletionEvidence`                                                  | Authenticated hotel checkout for one exact assignment, with actor, record, audit and command references | Attribution, collection and room-revenue classification; pending flags must retain their meaning                                                  |
| Booking `nightly_revenue_evidence` and manual refund allocations                      | Append-only nightly gross amounts, source revisions and exact refund/correction references              | Stable canonical item mapping, explicit tax/extras treatment and collected accommodation allocation                                               |
| Manual settlement/refund and Stripe settlement paths                                  | Booking-scoped payment operations and some concrete revenue/refund provenance                           | A complete immutable per-item collection/refund history and certified accommodation classification                                                |
| Finance payments/folios                                                               | Payment or accounting records                                                                           | Paid collection allocated to this booking/item; `net_amount` subtracts fees, and folio payment references can include pending/authorized statuses |

No current source supplies the entire join. `exact` nightly pricing quality does not
mean tax-exclusive accommodation, and a room-type/line-position match alone does not
establish a permanent stay-item identity. The current direct quote/offer functions
in `routes/bookingWebPublic.ts` deliberately return `PRICING_UNAVAILABLE` following
pricing retirement. VAY-1543 owns their replacement; do not restore old quote bodies
from the unmerged affiliate probe stack to make this connection appear functional.

## Required owner reads

The integration uses existing domain boundaries within the application. Finance
must not directly reinterpret Marketplace, Booking or PMS tables. Vendor adapters
remain behind the Booking/PMS evidence boundary; the earning calculation is the same
for native and external sources that actually satisfy these requirements.

| Fact                                    | Owning ticket/boundary                            | Required immutable meaning                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original opportunity and canonical item | VAY-1508, coordinated with VAY-1543               | Exact property/booking/item mapping and original accepted-booking provenance; replacement lineage and group/item overlap resolved                            |
| Attributed creator and terms            | VAY-1504/1506/1508 with VAY-1502                  | Complete relevant click history/cutoff, selected eligible click and event-time agreement version; current session/referral fields are not authority          |
| Accepted agreement                      | VAY-1502, after VAY-1501 publication              | Same immutable terms approved by hotel and accepted by creator, exact policy/destination/window references and effective lifecycle history                   |
| Completion/lifecycle                    | VAY-1505, existing PMS read where supported       | Exact-item completion assertion and provenance, or explicit cancellation/no-show/unknown; dates and payment alone never imply completion                     |
| Retained accommodation                  | VAY-1511 Finance boundary with Booking allocation | Exact item/currency, classified tax/extras exclusions, allocated discounts, collected accommodation and accommodation refunds, all with immutable references |

Each read must distinguish unavailable, incomplete and conflicting evidence and
provide an immutable revision/content identity plus current-head readiness. Provider
revision strings, timestamps and IDs are opaque until their owner establishes order.
Missing source coverage cannot be represented as an empty complete history.

For existing native revenue, preserve the Booking writer's exact line-position and
assignment lineage rather than guessing by room type or dates. Manual full settlement
is a candidate first path, not already qualified: without explicit accommodation-only,
tax-exclusive classification and complete collection/refund allocation it stays
unavailable. Do not infer tax zero from absent tax rows, divide a booking payment
proportionally without an accepted allocation, or subtract provider fees from the
commission base. Unknown currency precision also prevents calculation.

## Coherent revision and transaction boundary

Proposed ownership: Finance owns the immutable _earning-input reconciliation_ that
joins these owner-provided facts. Booking continues to own reservation identity,
source ordering and attribution evidence; this proposal does not move those decisions
into Finance. This reconciliation producer does not exist yet.

For each canonical property/booking/item, persist the exact component identities,
normalized content digest, provenance and readiness. Allocate a positive safe-integer
source revision only for a new coherently reconciled input. Never use the maximum
nightly revision, journal row count, delivery order or current timestamp as that
revision. Equal component identities with changed normalized facts are a conflict;
unchanged facts with another retrieval timestamp are not a new earning opportunity.

The producer must read immutable component versions and establish their compatible
head/lineage through owner APIs. Its concrete implementation must demonstrate a
consistent snapshot and atomic head advancement under concurrent owner changes,
using the existing lock order or an explicitly reviewed compare-and-set protocol.
Unordered raw events or multiple unrelated READ COMMITTED queries are not proof of a
coherent snapshot. Reserve no schema or generic event framework in this contract.

Commit the immutable reconciliation before invoking the existing journal command.
The journal's resolver reads that exact persisted revision inside the journal's own
transaction and verifies scope and provenance; it must not rebuild historical input
from today's mutable records or call a provider over the network. Do not nest the
current pool-owning command inside an unrelated transaction. A crash between source
commit and journal append is retried with the same source revision and input digest.

An owner change must invalidate reconciliation freshness or be detected by the
current-head check before an outcome can be called current. If a component owner
cannot expose unresolved newer input or invalidation reliably, freshness is unknown.
A successful journal write does not certify freshness. New unresolved evidence must
not leave an old calculated amount presented as current or payable.

## Outcomes without fabricated scope

Until original attribution and accepted agreement establish the creator/agreement/
policy scope, return evidence unavailable to the journal: do not invent placeholder
creator IDs or a zero earning. A proven unattributed booking has no affiliate earning
stream and is not the same as missing attribution evidence.

After scope is established, a coherent revision may record incomplete or conflicting
evidence as pending/review. Unknown collection remains null, not zero. An unavailable
source alone cannot fabricate a coherent revision; surface unknown/stale freshness
through the existing read contract instead. Later creator/agreement/policy reassignment
requires explicit owner reconciliation and the journal's scope-mismatch review; it
must not create a parallel stream or overwrite previous paid/history records.

Exact accepted Finance policy references are resolved through Finance, not replaced
by the latest hotel rate. Completion with pending flags is not blanket earning
approval: the owning evidence read must classify whether those flags block readiness.
Only sufficiently classified, collected and retained accommodation enters a verified
calculation. The accepted hold, funding and payout gates remain separate.

## Bounded implementation order

1. Complete the Marketplace immutable publication/approval/acceptance producer under
   existing VAY-1501/1502. Refresh existing #1918/#1919 work narrowly; do not import its
   old dependency stack. Publication still requires genuine readiness evidence.
2. Under VAY-1508, bind original referral context to the VAY-1543 replacement accepted
   booking transaction and expose exact historical canonical item/attribution reads.
   Tracking validation may use isolated non-earning diagnostics; it cannot require a
   live earning agreement to prove the path needed before publication.
3. Under VAY-1511, establish the first qualified item-level collection/classification
   producer using existing settlement/refund provenance. Approval/attribution and
   revenue work can proceed independently; neither substitutes for the other.
4. Add the immutable reconciliation producer and freshness reader, then connect the
   existing journal resolver. Add no always-pending or always-verified production stub
   merely to make a function callable. Keep creator earnings/payout reads gated until
   the real producers, authorization and consistency evidence are complete.

## Required connection tests

| Scenario                                                                           | Required result                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Hotel approves T1; creator accepts T2                                              | No accepted agreement and no journal scope                                 |
| Collaboration completes while independent agreement remains active                 | Agreement history remains active; no implicit link termination             |
| Gross nightly EUR500 without tax classification, or authorized-only payment        | Unavailable/pending, never verified EUR500 accommodation                   |
| Completed exact item, accepted 10%, collected accommodation EUR500 plus tax/extras | EUR50 only after exact classification and allocation are proven            |
| Accommodation refund EUR100 versus spa-only refund EUR50                           | Revised EUR40 versus unchanged EUR50; no repeated refund subtraction       |
| Two same-room-type assignments, room move, group plus items                        | Explicit lineage/allocation or review; never double-count or guess mapping |
| Agreement/refund/completion changes during reconciliation                          | Coherent old/new revision or stale/review; no mixed accepted snapshot      |
| Source committed; journal append crashes; retry repeats                            | One journal result for that exact source revision                          |
| Unknown or invalidated newer evidence without a journal row                        | Prior amount remains historical with stale/unknown freshness               |
| Inaccessible property/creator or revoked scope on retry                            | Denial before resolver/replay; no cross-tenant existence disclosure        |

Run real isolated database races/rollback tests for each implemented producer.
Synthetic resolver fixtures are useful command tests, not evidence that the source
join works. No real guest booking, checkout or payment is created to manufacture
positive acceptance evidence in the shared deployed test property.
