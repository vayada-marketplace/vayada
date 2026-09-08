# Marketplace affiliate offer terms

VAY-1501 prerequisite contract, 2026-09-08. Product authority: VAY-1056;
[shared journey](https://linear.app/vayadacom/document/shared-affiliate-interface-and-marketplace-journey-working-design-8736e1018fcf).

The user approved hotel-reviewed participation, linked-hotel credit, last eligible
click attribution with the window stated in the offer, verified-completion earning
eligibility and an agreement lifecycle independent from collaboration completion.
The first contract fixes those rules rather than exposing unsupported alternatives.

An offer's affiliate terms draft must explicitly supply:

- `bookingDestinationId`: the property's configured destination record, independent
  of whether Vayada or an external provider serves the booking flow.
- `financePolicyVersionId`: an immutable Finance-owned commission policy version.
  The Marketplace parser does not accept or calculate a commission percentage.
- `attributionWindowDays`: positive whole days; no silent default. The duration must
  be representable as exact integer milliseconds. Exact eligibility/window-boundary
  semantics belong to the attribution implementation, not this shape validator.

`parseMarketplaceAffiliateOfferTerms` validates only untrusted draft input. It rejects
unknown fields, malformed references and missing/invalid windows. It does not prove
property ownership, policy approval, destination readiness or permission to publish.
No guest data, raw provider credentials or redirect URL belongs in this contract.

Before persistence/publication, the application service must use existing property
authorization and resolve both references in that same property scope. Finance must
return a publishable policy version and its authoritative commission basis, rate,
qualifying/cancellation/refund conditions and currency presentation. Missing or
unapproved policy, unmatched property or unavailable evidence path prevents activation.
No numeric rate, revenue basis, payer, payout cadence or refund formula is chosen here.

Persist immutable terms versions with offer/program/property IDs and effective time.
Updating terms creates a new version; accepted agreement terms cannot be overwritten.
The actor/audit record and optimistic concurrency check belong to the command layer.
`MarketplaceAffiliateOfferTermsVersion` describes the eventual immutable record;
it is not an implemented repository, publication command or earning activation API.

Program status (draft/active/paused), offer moderation, agreement status and connection
readiness remain separate. Creator reads must combine the resolved Finance terms and
connection readiness, so a PMS subscription never implies affiliate eligibility.
Marketplace, PMS and Booking Admin reuse the same commands and reads.

The next slices add authorized reference resolution and versioned persistence, then
existing offer command/read integration and denial tests. This slice intentionally
has no route, database migration, link creation, provider integration or payment effect.
