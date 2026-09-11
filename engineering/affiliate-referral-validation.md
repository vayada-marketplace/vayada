# Affiliate referral validation before publication

VAY-1505, with VAY-1501 publication and VAY-1510 earning dependencies.
Implementation contract for the next evidence-path slices. No capture endpoint,
tracking storage, readiness override or earning is implemented by this document.

## Existing sources and their limits

| Existing source | Reuse | What it does not prove |
| --- | --- | --- |
| `apps/api/src/platform/bookingWebEvents.ts` | Existing event/audit persistence pattern | Click input includes a browser-supplied session and referral code; no accepted agreement or canonical booking binding. Its key collapses repeated clicks for the same slug/code/session. |
| `apps/api/src/routes/bookingWebPublic.ts` | Actual quote and checkout persistence | Quote `referralCode` is guest input. It cannot establish an authentic or complete eligible click set. |
| `apps/api/src/domains/bookingAffiliateCreationEvidence.ts` | Exact native creation time/event/request provenance | No creator identity or referral continuity. Current quote/checkout references alone cannot prove the original referral after an edit. |
| `apps/api/src/domains/pmsAffiliateCompletionEvidence.ts` | Existing exact-item authenticated checkout evidence | No referral identity, revenue classification or collected amount. |
| `apps/api/src/domains/bookingExternalNightlyRevenueEvidence.ts` | Existing reservation/night revenue evidence | `grossRoomAmount` cannot be renamed to Finance's `netAccommodationMinor`; taxes, extras, discounts, collection and refunds need classification. |

Legacy click events remain diagnostic input. Do not backfill them as verified clicks,
join them to bookings by a browser session string, or infer identity from guest PII.
Use owning-domain ports; this design adds no generic provider framework or service.

## Two separate flows

**Capability validation:** an authorized hotel manager selects an exact saved
destination version and starts a bounded validation run. It needs no published terms,
creator, agreement or earning link. A server-issued opaque probe follows the same
destination transport and booking correlation implementation intended for live use.
An explicitly synthetic reservation in an isolated test environment exercises the
real persistence path. The result records which capabilities were demonstrated,
their environment and immutable source evidence. It never calls the attribution
selector or Finance journal and cannot activate a program.

**Live earning:** publication consumes valid destination capability evidence plus
complete commercial conditions. Hotel approval and creator acceptance of the same
published version then permit link activation. The server resolves that stable link
to property/agreement/terms before recording an earning candidate. The Booking
creation transaction binds the supported tracking context and its click history
cutoff to the original booking. Historical agreement eligibility and the existing
last-eligible-click selector determine attribution; completion and classified net
accommodation revenue are resolved separately before invoking the journal.

This breaks the publication/active-link dependency without weakening either gate.
A probe proves transport capability, not consent, creator eligibility or an earning.
Probe exclusion must be enforced at intake, attribution and Finance resolution;
it cannot depend only on a label returned to a browser.

## Correlation and completeness boundary

The server creates distinct click occurrence identities, server timestamps and a
retry identity that deduplicates only a retry of that occurrence. Two real visits
through the same link must remain two ordered occurrences. A browser cannot supply
trusted property, creator, agreement, terms, click time or eligibility flags.

Opaque tracking references carry no guest PII or commission facts. Resolve scope,
purpose and validity on the server. A public stable link is shareable; possession
does not authorize hotel reads or prove guest identity. A probe reference can never
be resolved as a live agreement link. Destination redirects must use the exact saved
allowed destination, never an arbitrary guest-provided URL.

For native checkout, persist the original tracking-context reference and a durable
click-history cutoff atomically with booking creation. Later booking edits, retries
and new clicks cannot replace that original binding. Capture and booking creation
must serialize against the context so a click cannot commit into the closed prefix
after attribution reads it. Missing provenance or an unprovable cutoff stays pending.
An original booking reference must survive quote replacement.

Completeness is limited to the supported, evidenced tracking context. Do not claim
cross-device, cross-browser or cross-provider completeness from one cookie/token.
Lost context is pending, not a verified absence of referral. Corroborated replacement
bookings preserve the original opportunity, creation instant and attribution outcome,
including no attribution; a later click cannot switch the creator or refresh the window.
Unresolved replacement lineage requires review. Correcting proven invalid evidence
requires a separate restricted, audited correction; replacement linkage is not that
authorization. External
adapters must demonstrate their own reservation round-trip; native validation alone
cannot make an external destination ready.

Storage mechanism, consent basis, retention and cross-domain transport are separate
required decisions before live browser capture. This contract does not choose a
cookie default or permit tracking without those decisions. Tests use explicit
synthetic contexts and must report that limitation.

## Validation result and publication consumption

Retain the run ID, authorized actor/organization/property, exact destination version,
source connection/environment, adapter version, server start/completion times and
per-capability result with source references. Results distinguish validated, missing
and conflicting evidence. Never accept a browser-supplied `verified` flag.

Referral round-trip, reservation lifecycle, stay completion and accommodation revenue
are independently evaluated. Booking creation alone proves neither cancellation
updates nor stay completion. Gross-only or unpaid revenue is insufficient for the
net accommodation capability. Readiness remains pending until every required
capability and commercial prerequisite is satisfied for the actual destination.

Publication must recheck current authorization, exact destination/connection/adapter
scope and evidence validity inside its existing transaction boundary. Network
validation happens before that transaction. Revocation or relevant configuration
change invalidates reuse; old results remain historical. Evidence freshness policy
must be explicit before a production resolver is enabled; no indefinite validity
or arbitrary default lifetime is implied. Local/sandbox results must never be
silently promoted to production proof, even for the same provider.

## Delivery order and acceptance checks

1. Implement internal validation-run/probe identity and persistence, with fresh hotel
   authorization, exact destination scope, idempotency and audit. Test unauthorized
   retries, cross-property access, expiration/revocation and probe/live separation.
2. Add native capture and atomic original-booking binding in an isolated test flow.
   Test two creators' distinct clicks, repeated visits, retry deduplication, concurrent
   capture/booking, tampered references, lost context and booking edits. A replacement
   after a later creator click must preserve the original outcome, including no
   attribution. Assert that
   probes cannot reach the attribution selector or journal. Until browser transport
   decisions are settled, identify these as internal synthetic-context tests only.
3. Validate lifecycle/completion and classify collected accommodation revenue through
   existing owner-domain sources. Test cancellation/no-show, taxes/extras, discounts,
   partial accommodation refunds and conflicting scope. Missing sources stay pending.
4. Connect validated capability evidence to publication. Then implement matching hotel
   approval/creator acceptance and the live link path; validate the same transport
   with exact accepted terms before enabling earning resolution. Proposed pause/end
   and grace-window semantics in the agreement design remain unresolved decisions.
5. Connect trusted attribution, exact completion and classified revenue to the journal
   using a coherent source revision. Replays must preserve original attribution and
   corrections must not duplicate earnings. A stored calculation is not a payout.

Each item is a separate reviewable implementation slice. No shared guest reservation,
real payment or production checkout may be manufactured to pass validation. Follow
[booking evidence](affiliate-booking-evidence-contract.md),
[agreement boundaries](marketplace-affiliate-agreements.md) and
[earning rules](affiliate-earning-settlement.md).

## Initial validation identity storage

Migration 0183 adds immutable local/sandbox probe issuance and revocation records.
An issuance is the run's initial audit: exact destination/property/author organization,
actor/request, connection/environment/adapter identity, retry fingerprint and expiry.
Callers must choose an explicit lifetime; the technical ceiling is 24 hours for these
test resources, not a production tracking window or capability-evidence freshness rule.
Retry identity lasts with the record. Revocation is permanent and preserves issuance.
There is no creator/agreement association, booking, capability result or earning in
this storage slice. Server authorization and probe resolution belong to the command.
