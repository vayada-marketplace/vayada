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

## Draft revision storage (VAY-1501, second slice)

Migration 0173 adds `marketplace.affiliate_offer_terms_drafts`. Each append-only row
belongs to the existing offer/property/organization tuple and records its author,
request ID and creation time. A unique offer/revision pair prevents duplicate
revision numbers. Updating, deleting or truncating drafts is rejected by the database;
changing terms means inserting a new revision. No existing offers are backfilled.

These rows are drafts, not accepted agreements or published terms. Destination and
Finance policy IDs remain unresolved references: storage does not certify their
existence, property scope or readiness. No active/published flag is available here.
The future publication command must resolve both through their owning domains,
authorize the actor on every attempt, check the expected current revision under an
offer lock, and atomically record idempotency and audit evidence. An accepted terms
version will bind the verified draft to a program and effective time; it cannot
reinterpret an old draft as approval. This schema does not implement those commands.
