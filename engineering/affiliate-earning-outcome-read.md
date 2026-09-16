# Latest affiliate earning outcome read

VAY-1512, design-only slice, 2026-09-15. Runtime delivery remains dependent on
VAY-1511. This contract prepares one Finance-owned read of calculated outcomes;
it introduces no endpoint, balance, eligibility, payment or reporting repository.

## Sources and boundary

Follow [backend ownership](typescript-backend-structure.md),
[target database ownership](backend-database-restructure.md) and
[identity authorization](workos-identity-architecture.md). Marketplace consumes a
Finance-owned read, not direct queries into Booking/PMS or a second calculator.

The existing unmerged Finance stack supplies the semantics:

- [Earning journal contract](https://github.com/vayada-marketplace/vayada/blob/39bac7b366f89349a11e84baaa3ec8f173e5957f/engineering/affiliate-earning-journal.md):
  one stream per property/booking/stay item, ordered revisions and latest outcome.
- [Calculator result](https://github.com/vayada-marketplace/vayada/blob/39bac7b366f89349a11e84baaa3ec8f173e5957f/packages/domain-finance/src/affiliateEarning.ts):
  `pending`, `needs_review` or `calculated`; exact scope and minor-unit amounts.
- [Journal command](https://github.com/vayada-marketplace/vayada/blob/39bac7b366f89349a11e84baaa3ec8f173e5957f/apps/api/src/domains/financeAffiliateEarningJournal.ts):
  trusted exact-revision resolver; no production resolver or runtime caller.
- [Revenue evidence design](https://github.com/vayada-marketplace/vayada/blob/f5c8b55add8f42c20dbcf3376f551313c77ac0ee/engineering/affiliate-accommodation-revenue-evidence.md):
  classification, collection, item mapping and coherent revisions are prerequisites.

PRs #1926, #1931 and #1932 were open when this design started. Their code is not
present in the current main snapshot `0922591e9`. Refresh those slices and resolve
current migration names before implementing this reader; do not copy their old
migration numbering or create duplicate storage. These links pin semantics for
review, not a claim of deployed earnings.

## Selection and status

For each authorized canonical property + booking + exact stay item, select the
highest journal revision across **all** outcomes. Never select the latest successful
calculation first. A later pending/review row supersedes the displayed outcome,
while earlier amounts and paid history remain immutable.

Do not group by creator or policy to create another earning stream for the same
item. An attribution/accepted-scope change requires the owning reconciliation
process; the reader cannot move an earning to another creator or choose a winner.
It must not count both a booking total and constituent stay-item amounts.

| State          | Meaning in this read                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `calculated`   | Latest stored result contains an amount; it is not eligible, available to withdraw or paid.                       |
| `pending`      | Latest stored result lacks required evidence or policy; no current calculated amount.                             |
| `needs_review` | Latest stored result contains invalid/conflicting input or scope mismatch; no current calculated amount.          |
| Unavailable    | Reader/source coverage cannot be established; distinct from an empty result and from the journal result union.    |
| Empty          | Successful scoped journal query has no entries; means no recorded calculations, not no bookings or zero earnings. |

An explicit calculated `"0"` is a genuine recorded zero. Missing evidence,
unavailable storage, unsupported currency and an empty page must never become zero.
Do not create rows for bookings without journal entries merely to populate a view.

## Minimum read shape

These are fields for the first implementation, not a new shared event framework.
The first consumer is the authorized hotel; creator reads require the separate
participation-scoped authorization below before being exposed.

| Field                                                        | Rule                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propertyId`, `bookingId`, `stayItemId`                      | Canonical journal key; opaque references, no guest data.                                                                                                   |
| `creatorProfileId`, `agreementId`, `policyVersionId`         | Exact recorded scope, never current advertised terms substituted for historical terms.                                                                     |
| `entryId`, `journalRevision`, `sourceRevision`, `recordedAt` | Latest overall journal row; source revision is canonical reconciliation ordering, not provider receive time.                                               |
| `status`, `reason`                                           | Existing result status/reason; reason absent for calculated. Invalid stored shapes fail unavailable rather than guessing.                                  |
| `amount`                                                     | Null unless calculated; otherwise `{ commissionMinor, currency, currencyMinorUnit }` from that exact result. Integer string, no floating-point conversion. |
| `adjustmentMinor`                                            | Null unless calculated; difference from previous calculated total, not another earning total or transfer. Same currency/precision as amount.               |
| `freshness`                                                  | `current`, `stale` or `unknown`, based on the owning reconciliation read below, independent of stored result status.                                       |

The page adds `readAt`, coverage `available | unavailable`, an explicit unavailable
reason when needed and `nextCursor`. A database failure is a transport error, not
an available empty page. Missing runtime composition must remain visibly unavailable.
Per-item unknown freshness does not erase successfully read historical outcomes.

`current` requires the trusted owner to confirm this exact source revision is still
the latest coherent reconciled evidence with no known unresolved newer input.
`stale` means newer/unresolved input is known; `unknown` means freshness cannot be
proved. Include the owner's checked instant/revision when available, otherwise null.
`readAt` and journal `recordedAt` alone cannot establish source freshness. Without
that owner read, all results remain freshness unknown. Show calculated amounts as
last recorded calculations when stale/unknown, not current eligible balances.

There is no paid/eligible/processing field or aggregate balance in this slice.
Historical prior calculations belong to a later history read and must not be merged
into the current amount when the latest status is pending/review. Stored input and
raw evidence JSON are not response fields.

## Period, pagination and currency

The optional UTC interval is `[from, to)` over the latest row's `recordedAt`:
**select latest first, then filter**. It answers which calculations last changed
in that period, not bookings created, stays completed or revenue earned in it.
Omitting the interval returns all latest rows. A later outcome outside the interval
does not resurrect an earlier successful row inside it.

Paginate by the stable canonical `(bookingId, stayItemId)` key within one property,
with an opaque cursor bound to the authorized scope and filters. Reauthorize every
page; a cursor grants no access. Pages are live reads, not a frozen financial export:
new entries/updates between pages require a refresh, and the UI must not infer totals
by summing pages. Bound page size in the concrete route contract.

Keep currencies and precision explicit per row. Never sum currencies or use implicit
FX. Future aggregates need their own population/freshness semantics. This slice
does not expose click/conversion/source/campaign totals. Their later VAY-1512 reads
must exclude diagnostic traffic, retain unknown source and define distinct cohorts.

## Authorization and privacy

Require fresh trusted RequestContext, active actor/organization/membership, required
read permission and Marketplace entitlement, plus persisted enabled-property links
for the hotel scope. The concrete read policy must be defined/reviewed before the
route is mounted; operational PMS access alone is insufficient. Do not reuse the
internal journal command's hotel mutation permission as a creator read policy.

Creator reads must derive the creator profile from trusted identity and restrict
results to their authorized historical participation. Caller-supplied creator IDs
or another creator's journal scope cannot authorize access. Conflicting attribution
must not expose either party's private details to the other. Hotel managers see only
their authorized property. Revoked scope denies pagination and retries as well.

The protected route must use `enforceRoutePolicy`, return `no-store` on successes
and failures, and avoid revealing whether another tenant's item exists. Use owning
ports for agreement/freshness facts. No guest names, contact details, payment/provider
references, raw charge reports, evidence payloads or internal audit actors are sent
to Marketplace. Opaque booking/item IDs do not grant access to reservation APIs.

## Worked fixtures for implementation

Synthetic examples use one explicitly accepted 10% policy, EUR precision 2 and
explicit half-up calculator input. These are expected scenarios, not executed tests
or new commercial defaults. Revisions refer to one canonical item unless stated.

| Persisted facts / source state                                                         | Expected read                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No journal entries after a successful authorized query                                 | Available empty list; no claim of zero bookings/earnings.                                                    |
| Source/read unavailable                                                                | Explicit unavailable/error; no zero or manufactured pending journal row.                                     |
| R1 calculated `5000`, freshness confirmed current                                      | Calculated EUR50, adjustment `5000`; no payout claim.                                                        |
| R2 pending after R1 calculated `5000`                                                  | Pending, amount/adjustment null; R1 remains historical.                                                      |
| R3 calculated `4000` after R2 pending                                                  | Calculated EUR40, adjustment `-1000` against R1; not EUR40 plus another minus EUR10.                         |
| R4 review after contradictory refund/item evidence                                     | Review, amount null; do not display R3 as the current outcome.                                               |
| R5 calculated `0` after fully refunded accommodation                                   | Explicit zero, adjustment `-4000`; paid history unaffected.                                                  |
| Latest stored R1 calculated `5000`; newer source revision known but no journal row yet | Stored calculated EUR50, freshness stale; never claim current earnings.                                      |
| R1 calculated; reconciliation unavailable                                              | Stored calculated amount, freshness unknown; recorded time does not make it current.                         |
| Latest R2 outside requested period; R1 inside                                          | Item excluded; R1 not resurrected.                                                                           |
| Same item changes creator/policy and journal records scope mismatch                    | Review, not a second stream or creator reassignment; creator projection waits for authorized reconciliation. |
| Two distinct items: EUR `5000` and USD `3000`                                          | Two rows with separate currencies; no combined `8000` balance.                                               |
| Replayed same source revision                                                          | Same stored row/revision; reader never creates another adjustment.                                           |
| Earlier EUR50 payment, later calculated EUR40                                          | Read calculated EUR40 only; preserve payment elsewhere and keep EUR-10 correction distinct from transfer.    |
| Other property/creator ID, missing entitlement, inactive actor or revoked link         | Denied without existence/amount leakage, including cursor reuse.                                             |

## Delivery and acceptance mapping

Next: refresh the existing journal, implement one Finance-owned persisted reader,
then a protected hotel adapter wired into normal `server.ts` composition. Validate
latest-outcome selection, ordering, period boundaries, currency and denials with
actual local PostgreSQL fixtures; injected-route tests alone do not prove wiring.
Validate normal deployed reads after the actual revision is deployed, without
creating synthetic production earnings to manufacture a positive result.

VAY-1511 still owns trustworthy accepted agreements, attribution, completed-item and
classified retained-revenue resolution. VAY-1512 remains incomplete until its wider
performance/creator reads and runtime acceptance criteria pass; VAY-1513 owns account
UI. VAY-1514/1515 own settlement and payment history. This read does not choose hold
clock, payout cutoff, fees, funding, currencies or recovery policy, and cannot turn
elapsed time or a calculation into payable money.
