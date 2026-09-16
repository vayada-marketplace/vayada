# Affiliate percentage policy

VAY-1510 / VAY-1501. The user approved percentage-only commission on 2026-09-09:
each hotel chooses its rate, applied to accommodation revenue excluding taxes and
extras. No default rate. Eligibility still requires verified stay completion.
Authority: VAY-1056 and the shared affiliate journey in Linear.

Finance owns this policy. The hotel editor will send an explicit decimal percentage
string, such as `10` or `12.50`. The domain parser accepts 0 through 100 with at most
two decimal places, stores integer basis points (100 basis points = 1%), and returns
a canonical two-place percentage string for display. Zero is an explicit zero rate,
never a missing-value fallback. This is input precision/range, not a suggested rate.

The only model is `percentage`; the fixed basis is
`accommodation_excluding_taxes_and_extras`. Unknown request fields are rejected,
including attempts to override the model, basis, eligibility or property. The
policy object is frozen and contains no guest or provider data.

Marketplace refers to an immutable Finance policy version by ID. The resolver must
match that exact version and property and require approval before exposing a usable
policy. It never falls back to the latest version, a different hotel, or a default
rate. A resolver result confirms the commission component only; it is not authority
to publish an offer, attribute a booking or pay a creator.

Example: accommodation EUR500, taxes EUR50 and extras EUR100; an explicitly chosen
10% policy uses EUR500, giving EUR50 before any separately applicable adjustments.
The editor must show the basis next to the rate. Provider adapters must supply an
explicitly classified accommodation amount; a total-only booking cannot be treated
as commissionable accommodation revenue.

Implemented layers cover policy validation, immutable storage and authorized save
and approval commands, plus persisted exact-version resolution. HTTP adapters and the
hotel editor are described below. The accepted cancellation/refund, payer and payout
cadence rules are now recorded in [earning and settlement](affiliate-earning-settlement.md).
Detailed evidence allocation, currency/rounding, exact scheduling and pricing remain
separately scoped there; no settlement calculator or earning activation is introduced. Existing accepted agreements must retain their
original policy version when a hotel later changes its rate.

## Immutable storage

Migration 0180 stores Finance policy versions with a canonical property ID, explicit
basis-point rate, fixed contract/model/basis/eligibility and author/request/time.
Approval is a separate append-only record tied to the exact version/property tuple,
with approving organization/user/request/time. A version is a draft until its approval
record exists. Neither rate versions nor approval evidence can be updated, deleted
or truncated. New rates require new version IDs; old agreements keep their references.

Property, user and organization foreign keys establish record identity, not current
actor authorization. Commands must verify hotel ownership/permission and
write idempotency/audit evidence atomically before recording approval. Approving this
commission component does not publish offers or establish booking/settlement eligibility.
No existing drafts or historical Finance records are backfilled or reinterpreted.

## Saving a chosen rate

The first internal save entry point serves the Marketplace hotel editor. A fresh
RequestContext must grant marketplace.profile.manage, an active hotel-profile
entitlement and an owner/operator link to the canonical property. The transaction
rechecks and locks the persisted organization link and enabled property before
creating a Finance-owned version. It records author, organization and request.
Repeated actor/property/key/input requests return the original version; changed
input under that key fails. Saving another explicit rate creates another draft
version, without replacing an approved version or changing existing agreements.
Save does not approve the commission component. The separate approval command below
records that decision. No HTTP route is exposed yet; editor integration follows. Additional product adapters
must use their own explicit authorization boundary with the same Finance storage.

## Approving an exact version

Approval uses the same Marketplace permission, active entitlement and owner/operator
property access as saving, rechecked before replay. The transaction locks the
enabled property and persisted organization link, then selects only the requested
version for that property and its authoring organization. Approval records the
approver, organization and request without editing the rate. The same actor and key
replay the original result; reusing the key for another version or actor conflicts.
A different key for an already-approved version returns already_approved, preserving
the first approval evidence. Approval covers only the commission component; it does
not publish an offer, activate a link or authorize earnings or payout.

## Resolving stored policy references

Finance exposes an internal read operation for an exact property/version pair. It
loads the immutable rate and matching approval together, validates the stored fixed
model and basis, and delegates to the domain resolver. An unapproved version stays
unavailable even if another version is approved. An unknown version or a version
from another property returns not_found without revealing the other hotel's data.
Malformed identifiers also return not_found before querying. Database failures
propagate rather than masquerading as missing policy. The operation accepts a pool
or transaction client; authorized callers supply the canonical property from their
resource scope. It is not a public read endpoint or a publication/settlement gate.

## Marketplace policy HTTP adapter

All paths below are under `/api/marketplace/properties/:propertyId/affiliate-policies`
and require fresh Marketplace profile-manage permission, active hotel identity,
owner/operator property access and active hotel-profile entitlement. Responses are
no-store. POST `/` accepts exactly the Finance parser's `{percentageRate: string}`
body and a single nonempty Idempotency-Key (maximum 200 characters, no commas). POST
`/:policyVersionId/approve` uses that header with no body. Each returns 201 when
created or 200 for replay; invalid requests are 422, unavailable scope 404 and
conflicts (including already-approved) 409. GET `/:policyVersionId` returns the
exact approved policy (200), missing/wrong-property reference (404), or an unavailable
unapproved/invalid policy (409). Database failures remain server errors.

The editor's authorized GET collection returns the 20 most recently recorded policy
versions for the exact property and selected authoring organization, with rate basis
points, timestamp and approval state. This is editing history, not an active-rate
selector: no version becomes effective merely because it is newest. Existing offer
references and agreements retain their exact version. Empty history returns an empty
list. The same route permission, entitlement and property checks apply.

## Hotel commission editor

The hotel profile Offers tab now includes an explicit percentage input, recent
draft/approved rates, and review-before-approval for each immutable version. It uses
the authenticated target API and canonical profile property ID, remounting when
the selected property changes. Failed writes retain their retry key within the
current editor session. Loading and recoverable failures are visible; refreshing
reads stored history. Approval does not attach a policy to an offer, select an
active rate or activate links. Offer-term association remains a subsequent step.
The old collaboration-offering form also no longer invents a 5% commission.
