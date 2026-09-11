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

The internal `manageAffiliateValidationProbe` command creates, resolves and permanently
revokes these identities. Every call requires fresh hotel management context and
entitlement, plus a persisted active property relationship locked before retry lookup.
The server supplies deployment identity; no public input may choose an environment,
connection or adapter. An `avp_` reference resolves only in its exact authorized scope
and configuration while unexpired and unrevoked. Revocation remains available for
expired or old-configuration probes. No HTTP route or actual capture/booking binding
is wired yet; probe existence does not validate that the supplied connection works.

The dedicated internal checkout configuration can now resolve a probe with fresh
hotel authority under the checkout transaction's property lock. Migration 0184 stores
its original booking binding atomically; booking edits cannot overwrite that row.
Probe identity participates in checkout retry identity. Missing authority, revocation,
expiry or changed configuration blocks validation checkout, including retries.
This configuration is not wired in the server or exposed as guest input. Integration
tests inject a synthetic server context into the actual checkout adapter; they do
not demonstrate browser/quote transport, click-history completeness, a real provider,
production eligibility, creator attribution or Finance exclusion of future live flows.

The diagnostic HTTP checkout request now requires `validationProbe` to exactly match
the server-selected probe when validation configuration is enabled. Supplying this
field without that configuration is rejected; missing/mismatched values cannot create
a validation booking. The field conveys an opaque test identity, not hotel authority
or creator eligibility. Fresh server authorization and probe resolution still apply.

The opt-in Chromium test (`TEST_AFFILIATE_BROWSER=1` with an isolated
`TEST_DATABASE_URL`) serves a minimal diagnostic page and sends JSON through the real
HTTP booking route into the actual checkout/database adapter. It verifies rejection,
successful creation/replay and exact binding without cookies or local/session storage.
It requires the existing Playwright Chromium installation. This is not the normal
Booking Web guest UI, cross-origin/provider transport,
live link capture or deployed-account evidence. No guest-facing tracking is enabled.

Diagnostic quote creation now requires the same request probe and fresh server
authority as booking creation, using the property write lock before either operation.
Migration 0185 preserves the quote/probe relationship immutably in the quote transaction.
Probe identity participates in quote/retry identity. Checkout resolves this relationship
from Booking storage: an unbound quote cannot enter diagnostic checkout, a different
probe cannot claim it, and a diagnostic quote cannot enter normal checkout by dropping
the request field. Historical pre-binding quotes are not backfilled as validated.

The Chromium diagnostic now generates its quote through the real quote HTTP route
and uses the returned reference/amount for booking. It still does not exercise the
normal guest UI, a creator link, cross-origin/provider transport or live attribution.

The internal `readBookingAffiliateProbeEvidence` read checks current hotel authority
and exact unexpired/unrevoked deployment probe scope before looking up a booking.
It reads original native creation provenance and the immutable booking binding in
a transaction holding the property lock, which serializes binding insertion and
revocation. READ COMMITTED observes revocations committed while acquiring that lock;
the binding is immutable. Their request IDs must agree; conflicting provenance needs
review, and absent bindings stay pending. Replacing a booking's current quote cannot
replace its original probe evidence. A recorded result includes the diagnostic purpose,
local/sandbox environment, destination/connection/adapter and original creation source.
It proves only the native diagnostic booking binding, not browser transport, a live
creator click, readiness, completion or revenue. It is not a historical access endpoint:
expired/revoked probes remain stored but cannot be resolved through this read. There
is no HTTP wiring, publication consumption or Finance call in this slice.
