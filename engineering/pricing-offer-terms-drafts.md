# Offer terms stay in draft until pricing approval

VAY-1996 · 12 September 2026 · implementation contract

This extends [replacement pricing](replacement-pricing-contract.md) for existing
offer cancellation/payment editing and new-offer creation. It defines the next
implementation; the current writer does not yet provide these guarantees.

## Hotel behavior

A hotel changes an offer from free cancellation seven days before arrival to
free cancellation fourteen days before arrival. Saving that draft must leave
the approved seven-day policy and its prices usable. Only approval activates
the fourteen-day policy together with the reviewed replacement prices. Canceling
or abandoning the draft has no effect on the approved offer.

The same rule applies when adding another offer or room: creating its policy
must not invalidate the property's existing approved prices. Failed validation,
an unavailable payment schedule, or a lost response must not leave a partially
activated configuration. Accepted bookings retain their frozen terms/evidence.

## Current failure path

- `createBookingPricingOfferTermsStore.save` in
  `apps/api/src/domains/bookingPricingOfferTerms.ts` inserts immutable terms and
  immediately advances `booking.pricing_v2_offer_term_heads`.
- `lockBookingPricingTermsSource` hashes every current terms head in the property.
  A changed policy **or a newly added offer** changes that source hash.
- `createReplacementPricingStore.read` compares the active publication's saved
  sources with current sources and reports it stale. Its publication still
  exists; this does not establish a deployed checkout outage.
- `PricingEditor.createInitial` currently saves terms before preparing a draft.
  A failed preparation, cancellation, or abandoned new-offer flow cannot undo
  the committed head change. This affects existing add-room/add-offer flows as
  well as the proposed existing-policy editor.
- Preparation and `lockReplacementPricingOfferOwners` accept only current-head
  terms. Inserting a candidate row alone cannot enable draft policy editing.

## Ownership and stored identity

Booking remains the single owner of policy contents and active policy heads.
Reuse its immutable terms rows, full parser, identity authorization, room-scope
adapter and request receipt conventions. Add Booking-owned immutable candidate
metadata identifying property, room, offer, candidate terms revision, pricing
draft ID, base pricing revision and expected active terms revision (null for a
new offer). Candidate revisions are server-assigned; a supplied UUID alone is
never proof of ownership or draft membership.

The draft ID is allocated before staging and is the same ID used by PMS draft
storage. Staging may precede the first saved draft, as first setup needs terms
before preparation. It must verify the expected base pricing revision through a
PMS-owned port and bind the candidate to that base and draft ID. Another draft
cannot adopt it. Editing again creates a new immutable candidate; the complete
saved draft selects exactly one revision per offer. Unselected candidates are
inert and never become current by being read or retried.

A Booking draft resolver accepts the complete offer references derived from the
proposed PMS snapshot and a server-verified draft context. Each reference must
be either the exact active revision or a candidate bound to that property,
draft, base pricing revision, room and offer whose expected active head still
matches. Reject missing references, duplicates, foreign candidates, candidates
from another draft/base, and arbitrary historical revisions. Every selected
candidate must occur in the proposal; no extra head mutations are allowed.

Published consumers retain the existing current-only resolver. Draft policy
reads use a separate authorized, draft-scoped read path so the editor can show
the exact saved candidate. Neither reader silently substitutes a newer policy.

## Two distinct source sets

The existing single `sources` value cannot represent both the active baseline
and a draft containing inactive policies. Persist these two roles explicitly in
the draft envelope; do not add policy copies to PMS room configurations:

| Evidence          | Meaning                                                                               | Use                                              |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Baseline sources  | Current room, active Booking terms heads and Finance sources captured for preparation | Concurrency and stale checks before approval     |
| Effective sources | Sources that will exist after activating exactly the selected candidates              | Finance/charge review and the published revision |

Booking computes the effective terms hash by replacing/inserting selected
candidate heads in the complete locked active head set, using the same canonical
hashing as the active source reader. It preserves all unselected heads. Room
and Finance source hashes remain the live baseline hashes; Finance readiness
evidence is separately derived from the complete proposed terms, currency and
next pricing revision. Client-supplied projected hashes are never authoritative.
With no candidates, baseline and effective source sets are equal.

Preparation, draft save/read, charge review/confirmation and publication use
one shared owner composition for this distinction. Recheck the active baseline,
candidate membership and expected heads, and recompute effective sources at
each guarded step. An intervening active source change makes the draft stale;
do not auto-rebase or silently refresh the user's approval. Draft contents and
effective sources are persisted together with optimistic draft revision checks.

The charge fingerprint binds the complete proposed snapshot, exact selected
terms revisions, Finance readiness evidence and **effective** sources. Charge
confirmation also validates the baseline, draft ID and expected saved draft
revision. Editing a policy or replacing a candidate requires a new review and
confirmation. Preserve the existing exclusion of the declaration's own ID from
its fingerprint, allowing that ID to be attached without changing the reviewed
commercial contents. Publication still requires the exact saved draft and its
matching declaration; a client acknowledgment or hash alone authorizes nothing.

## Atomic approval

Extend the existing PMS publication transaction through explicit Booking-owned
ports. Do not start a nested transaction or make an HTTP call between owners.
Keep the existing property mutation lock and consistent authorization/room/terms/
Finance lock ordering; retain all relevant locks through commit.

1. Recheck live manage authorization. Look up the publication receipt before
   requiring the old draft, baseline or candidate heads to remain current.
   Exact historical retry returns its original result; conflicting request reuse
   fails. Authorization remains required even for a historical receipt.
2. Lock and verify the exact saved draft/revision, expected PMS publication
   revision, baseline sources and selected candidate ownership/expected heads.
3. Recompute the effective source set. Resolve full proposed terms through
   Booking and recheck Finance readiness and the charge declaration against the
   exact proposal and effective sources. A deposit is still unavailable until
   Finance can execute it; storing requested terms never grants that capability.
4. Activate exactly the selected candidate heads through Booking's port, then
   recompute current sources under the same locks and require equality with the
   effective sources. Run final current-owner validation on the proposal.
5. Write the immutable PMS publication with those effective sources, advance its
   head, and write activation/publication audit, outbox and receipt effects in
   the same transaction. Commit once. Any failure, including an effect failure,
   rolls back both owners' heads and all activation/publication effects.

Readers honoring these existing transaction locks observe either the old
approved state or the new approved state. They never accept a mixed pair. A
second draft based on the old publication loses the revision race and must be
reviewed again. Retrying a successfully staged candidate does not activate it;
retrying an old successful publication never reactivates old heads.

Staging records an auditable draft action with a distinct event type. It must
not emit the existing active `booking.pricing_terms.revised` signal or enqueue
channel distribution. Activation emits the active change in the publication
transaction. Consumers must route candidate-stage events away from active-rate
invalidation. Abandoned candidates need no synchronous cleanup or rollback job.

## Editor and route transition

Migrate first setup, add-room and add-offer flows as well as the new existing-offer
editor to staging. Apply edits locally; Save draft stages selected terms and
saves the complete pricing draft. Track the exact staged result across retries.
Show exact saved candidate policies during review. Disable conflicting actions
while a save/retry is pending and invalidate prior review after any edit.

After all callers migrate, remove the independently committing terms-head writer
from the ordinary pricing HTTP surface. Its old route must fail closed rather
than allowing clients to circumvent atomic approval. Do not expose an activation
endpoint separate from pricing publication. Retain current active reads and the
separate draft-scoped reads. No old writer fallback is allowed when staging fails.

Support the full existing cancellation contract (non-refundable, flexible,
partial-refund fields/tiers and text) without discarding fields on save. Show
requested full/deposit schedules accurately; never advertise deposit execution
without Finance readiness. Per-offer payment-method configuration needs its own
Finance contract and is not invented by this change.

Existing active publications and historical terms remain readable. Existing
drafts without candidate metadata can use baseline=effective only after exact
current-source validation; stale drafts must be recreated. Do not repair active
heads automatically from older publications. No production Python changes or
destructive data migration are required by this contract.

## Implementation order and proof

| Step                          | Concrete owner/modules                                                                                                                                                                                                                       | Required proof                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Stage and resolve policies | Booking: `bookingPricingOfferTerms.ts`; PMS base-revision port; candidate metadata migration                                                                                                                                                 | Real PostgreSQL: active head/source unchanged after stage, full policy fidelity, expected-head/base checks, cross-property/draft rejection and idempotent replay                                                                                                  |
| 2. Bind drafts and approval   | PMS: `replacementPricingCommands.ts`, `replacementPricingStore.ts`, `replacementPricingStorageGuard.ts`, `replacementPricingOfferOwners.ts`, `replacementChargeDeclarations.ts`; Booking activation port; existing Finance readiness adapter | Real PostgreSQL: projected-source/charge consistency, before-and-after active reads, atomic rollback, concurrent drafts, stale sources, denied Finance, exact retry after later publication, and authorization denial matrix                                      |
| 3. Connect hotel controls     | PMS routes/client, `PricingEditor.tsx`, `PricingTerms.tsx`, first/new-offer setup                                                                                                                                                            | Component tests and real signed-in browser: edit/save/reload/review/approve, complete tiers/text retained, cancel/abandon leaves approved policies unchanged, lost-response retry and stale review rejected; migrate callers and disable old write route together |

Flamur remains the accountable implementation assignee in Linear. The table
names the concrete code owners and boundaries; no unassigned external team is
assumed. These steps depend in order and should be small stacked PRs under
VAY-1541/1544, with VAY-1561 preserving Booking ownership. None may weaken current
published-consumer checks to make a candidate pass.

The end-to-end regression must start with an approved publication, stage both
an existing-offer change and a new offer, and prove the old publication remains
current until approval. Inject failure after Booking activation and before PMS
commit to prove rollback, then approve successfully and prove the new publication
is immediately current. Simulate a lost success response and a later publication
before retrying to prove history is returned without side effects. Local tests
do not establish deployed checkout or OTA delivery; those consumers retain
their separate acceptance work.
