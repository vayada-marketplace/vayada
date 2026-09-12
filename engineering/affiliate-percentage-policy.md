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

This slice adds policy validation and version selection. Persistence, owner approval
commands and hotel editor integration follow. Refund/no-show handling, discount
allocation, payer, platform fees, currency conversion, rounding of earned amounts
and payout scheduling remain outside this contract; no settlement calculator or
earning activation is introduced. Existing accepted agreements must retain their
original policy version when a hotel later changes its rate.

## Immutable storage

Migration 0180 stores Finance policy versions with a canonical property ID, explicit
basis-point rate, fixed contract/model/basis/eligibility and author/request/time.
Approval is a separate append-only record tied to the exact version/property tuple,
with approving organization/user/request/time. A version is a draft until its approval
record exists. Neither rate versions nor approval evidence can be updated, deleted
or truncated. New rates require new version IDs; old agreements keep their references.

Property, user and organization foreign keys establish record identity, not current
actor authorization. Future commands must verify hotel ownership/permission and
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
Save does not approve the commission component. No HTTP route is exposed yet;
approval, persisted resolution and the editor follow. Additional product adapters
must use their own explicit authorization boundary with the same Finance storage.
