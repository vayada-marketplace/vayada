# Affiliate referral validation before publication

VAY-1505, with VAY-1501 publication and VAY-1510 earning dependencies.
Implementation contract for the next evidence-path slices. No capture endpoint,
tracking storage, readiness override or earning is implemented by this document.

## Existing sources and their limits

| Existing source                                                 | Reuse                                               | What it does not prove                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/platform/bookingWebEvents.ts`                     | Existing event/audit persistence pattern            | The public route accepts a browser-supplied session, referral code and optional click ID. Persistence deduplicates `slug/referralCode/clickId`, while a missing click ID receives a new server UUID. The supplied click ID is therefore an untrusted retry identity; there is no accepted agreement or canonical booking binding. |
| `apps/api/src/routes/bookingWebPublic.ts`                       | Actual quote and checkout persistence               | Quote `referralCode` is guest input. It cannot establish an authentic or complete eligible click set.                                                                                                                                                                                                                             |
| `apps/api/src/domains/bookingAffiliateCreationEvidence.ts`      | Exact native creation time/event/request provenance | No creator identity or referral continuity. Current quote/checkout references alone cannot prove the original referral after an edit.                                                                                                                                                                                             |
| `apps/api/src/domains/pmsAffiliateCompletionEvidence.ts`        | Existing exact-item authenticated checkout evidence | No referral identity, revenue classification or collected amount.                                                                                                                                                                                                                                                                 |
| `apps/api/src/domains/bookingExternalNightlyRevenueEvidence.ts` | Existing reservation/night revenue evidence         | `grossRoomAmount` cannot be renamed to Finance's `netAccommodationMinor`; taxes, extras, discounts, collection and refunds need classification.                                                                                                                                                                                   |

Legacy click events remain diagnostic input. Do not backfill them as verified clicks,
join them to bookings by a browser session string, or infer identity from guest PII.
Use owning-domain ports; this design adds no generic provider framework or service.

## Two separate flows

**Capability validation:** an authorized hotel manager selects an exact saved
destination version and starts a bounded validation run. It needs no published terms,
creator, agreement or earning link. Publication evidence has two named parts. Adapter
certification uses explicitly synthetic reservations, lifecycle changes, completion
and revenue fixtures in an isolated environment to exercise the same versioned
implementation intended for live use. Each of the four existing tracking purposes
then requires a production preflight against the exact destination version and the
selected production connection for that purpose, without creating a reservation,
consuming inventory or initiating payment. Referral preflight must prove that the
destination preserves and returns the server-issued, non-earning correlation reference.
Lifecycle, completion and revenue preflights must prove authenticated read capability,
required source fields and the configured property mapping through a provider-documented
non-mutating mechanism. Each result links the exact adapter, destination, connection,
purpose and both environments to immutable source evidence. It never calls attribution
or Finance and cannot activate a program.

Current certification plus the exact production preflight must independently produce
healthy validated evidence for `referral_round_trip`, `reservation_lifecycle`,
`stay_completion` and `accommodation_revenue`, preserving the existing four-purpose
publication gate. The proof establishes capability without claiming that a production
reservation, stay or revenue event occurred. Actual production evidence begins with
the first organic booking and can still become pending or conflicting. A provider or
selected connection without a documented non-mutating production preflight for its
purpose remains unavailable for publication; sandbox success, a redirect-only check or
a manual `verified` flag cannot substitute for it.

**Live earning:** publication consumes valid destination capability evidence plus
complete commercial conditions. Hotel approval and creator acceptance of the same
published version then permit link activation. The server resolves that stable link
to property/agreement/terms before recording an earning candidate. The Booking
creation transaction binds the supported tracking context and its click history
cutoff to the original booking. Historical agreement eligibility and a separately
implemented last-eligible-click selector determine attribution; completion and classified net
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
authorization. External adapters must earn certification through their own synthetic
reservation round-trip and pass the exact production preflight; native validation
alone cannot make an external destination ready.

Storage mechanism, consent basis, retention and cross-domain transport are separate
required decisions before live browser capture. This contract does not choose a
cookie default or permit tracking without those decisions. Tests use explicit
synthetic contexts and must report that limitation.

## Validation result and publication consumption

Retain the run ID, authorized actor/organization/property, exact destination version,
source connection/environment, adapter version, server start/completion times and
per-capability result with source references. Results distinguish validated, missing
and conflicting evidence. Never accept a browser-supplied `verified` flag.

Tracking transport, reservation lifecycle, stay completion and accommodation revenue
are independently evaluated. Publication retains the existing four-purpose gate: each
purpose needs current adapter certification plus an exact healthy production preflight
for its selected connection. This validated capability evidence does not label a
synthetic booking as production reservation, completion or revenue evidence. Booking
creation alone proves neither cancellation updates nor stay completion. Gross-only or
unpaid revenue is insufficient for an earning calculation. Live earning remains
pending until the required organic evidence and commercial prerequisites exist.

Publication must recheck current authorization, exact destination/connection/adapter
scope and evidence validity inside its existing transaction boundary. Network
validation happens before that transaction. Revocation or relevant configuration
change invalidates reuse; old results remain historical. Evidence freshness policy
must be explicit before a production resolver is enabled; no indefinite validity
or arbitrary default lifetime is implied. Local/sandbox certification must never be
relabeled as production evidence, even for the same provider. Publication may consume
it only as the certification half of each purpose's explicit two-part readiness result,
together with a fresh production preflight for the exact adapter, selected connection,
destination version and purpose. The existing `assessAffiliateDestinationTracking`
four-purpose decision remains unchanged.

## Delivery order and acceptance checks

1. Implement internal validation-run/probe identity and persistence, with fresh hotel
   authorization, exact destination scope, idempotency and audit. Test unauthorized
   retries, cross-property access, expiration/revocation and probe/live separation.
2. Implement the pure last-eligible-click selector against ordered, trusted click
   occurrences and the persisted booking cutoff. It must not accept browser eligibility
   flags or current agreement state as historical proof.
3. Add native capture and atomic original-booking binding in an isolated test flow.
   Test two creators' distinct clicks, repeated visits, retry deduplication, concurrent
   capture/booking, tampered references, lost context and booking edits. A replacement
   after a later creator click must preserve the original outcome, including no
   attribution. Assert that
   probes cannot reach the attribution selector or journal. Until browser transport
   decisions are settled, identify these as internal synthetic-context tests only.
4. Implement versioned adapter certification and exact, non-mutating production
   preflight evidence for all four tracking purposes and every selected connection.
   Providers without a safe preflight for a required purpose remain unavailable. Prove
   that certification/preflight probes cannot become booking, attribution, journal or
   payment evidence, and feed one current evidence row per purpose into the existing
   assessment without weakening it.
5. Validate lifecycle/completion and classify collected accommodation revenue through
   existing owner-domain sources. Test cancellation/no-show, taxes/extras, discounts,
   partial accommodation refunds and conflicting scope. Missing sources stay pending.
6. Connect the four two-part readiness results to publication. Then implement matching
   hotel approval/creator acceptance and the live link path; validate the same transport
   with exact accepted terms before enabling earning resolution. Proposed pause/end
   and grace-window semantics in the agreement design remain unresolved decisions.
7. Connect trusted attribution, exact completion and classified revenue to the journal
   using a coherent source revision. Replays must preserve original attribution and
   corrections must not duplicate earnings. A stored calculation is not a payout.

Each item is a separate reviewable implementation slice. No shared guest reservation,
real payment or production checkout may be manufactured to pass validation. Follow
[booking evidence](affiliate-booking-evidence-contract.md),
[agreement boundaries](marketplace-affiliate-agreements.md) and
[earning rules](affiliate-earning-settlement.md).

## Initial validation identity storage

Migration 0212 adds immutable local/sandbox probe issuance and revocation records.
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

The internal binding helper can resolve a probe with fresh hotel authority while the
caller holds a checkout transaction's property lock. Migration 0213 stores an original
booking binding atomically; booking edits cannot overwrite that row. Missing authority,
revocation, expiry or changed configuration blocks resolution. No public checkout
adapter, server route or guest input is wired to this helper yet, so validation cannot
enter payment, PMS handoff, notification or revenue-evidence paths. Integration tests
exercise fresh scope resolution and immutable binding against PostgreSQL; they do not
demonstrate browser/quote transport, click-history completeness, a real provider,
production eligibility, creator attribution or Finance exclusion of future live flows.

The browser transport test remains an internal test harness and is never registered by
the API server. It accepts only the selected opaque probe, verifies the database name is
explicitly isolated, and creates a zero-value synthetic draft plus its binding in one
transaction. Missing, forged or scope-bearing input is rejected before any write; replay
does not create another row, including simultaneous delivery. A fail-on-write Finance
journal trigger proves the probe path creates no earning record. The opt-in Chromium case
proves referrerless JSON transport while cookie and local/session storage access are
blocked. Because the harness never calls normal checkout, it cannot reserve inventory,
initiate payment, hand off to a PMS or notify a guest. This is a VAY-1506 implementation
sub-slice: synthetic transport evidence only, not a production route, stable-link/click
capture, quote round-trip, provider certification or live booking. Attribution dispatch
and its explicit probe exclusion remain unimplemented, so this does not complete
VAY-1506's remaining acceptance criteria.

## Initial referral transport certification storage

Migration 0215 adds immutable successful adapter-certification evidence for the
`referral_round_trip` capability. Every certification is pinned through database keys
to one real diagnostic probe-to-booking binding and to that probe's exact property,
destination, author organization, local/sandbox environment, connection and adapter
version. The row retains bounded evidence references, verifier actor/request and server
completion time. It is permanently marked `capability_validation`; it cannot be stored
as production preflight, another capability or earning evidence.

Certification insertion locks and rechecks an unexpired, unrevoked probe and requires
exactly one diagnostic booking binding; zero or multiple deliveries fail as unavailable.
Binding insertion uses the same probe lock and prevents new second deliveries before or
after certification. The database supplies completion time and rejects non-string, blank
or oversized evidence references. Historical duplicate probe bindings therefore do not
block migration, but they cannot be certified or silently collapsed into one successful
result.

This is only durable storage for the successful synthetic certification half. The internal
Booking verifier command is its application writer: it reauthorizes current hotel scope,
locks and rechecks the exact probe/deployment, derives the sole binding, and requires the
bound booking to remain a zero-value diagnostic draft with no existing Finance journal.
Binding and Finance-journal inserts take the same database lock, and each rejects the
other record, so a new diagnostic booking cannot race into earning evidence. The verifier
accepts evidence references only through server-owned configuration. Readiness must
separately require a current exact production preflight for the same capability.
Missing/conflicting run outcomes, other three capabilities, freshness, revocation-aware
consumption and publication/activation wiring remain later slices. The table alone does
not make a destination, publication, agreement, click or booking eligible for earnings.

## Initial referral production preflight storage

Migration 0218 stores immutable successful production preflight evidence for the
`referral_round_trip` capability. It pins the exact property, destination, author
organization, production connection and adapter version, plus a one-time correlation
hash and bounded source references. The fixed assertion says only that a documented
non-mutating check returned the opaque correlation without creating a booking. Database
time replaces caller completion time, and permanent revocation preserves old evidence.

This table is not readiness by itself and has no booking, creator, agreement, click,
attribution or Finance association. Multiple historical checks are retained, while the
same correlation cannot be replayed for any configuration. A later authorized
verifier must create rows from real provider evidence. A later reader must define and
enforce freshness, reject revoked or changed configuration, and require the matching
current adapter certification before publication can consume the result.

## Initial referral production preflight command

Migration 0219 and the internal production preflight command add retry identity to the
stored evidence and invoke a generic provider verifier. The command authorizes the hotel
and exact saved destination before any provider call, generates the opaque correlation
on the server, and accepts success only when the verifier returns that exact correlation
for the configured live connection and adapter version with bounded source references.
The verifier call has a server-owned timeout and receives an abort signal.

The command serializes the same hotel retry key through the provider call, so concurrent
retries produce one check and one immutable evidence row. A retry with changed actor,
destination, connection or adapter is a conflict. Provider failure, mismatched evidence
or timeout records nothing. The provider port is intentionally generic: Channex, another
PMS adapter or a native Booking implementation supplies the same non-mutating contract.
No provider-specific table is part of the command.

This command still does not grant readiness. It creates no reservation, inventory,
payment, creator, agreement, click, attribution or Finance record. A later reader must
apply an explicit freshness policy and require current non-revoked production evidence,
unchanged configuration and matching current diagnostic certification.

## Initial referral readiness reader

The Booking-owned `referral_round_trip` reader requires both an unrevoked diagnostic
certification and an unrevoked production preflight for the exact property, destination,
organization and adapter version. The server supplies the exact local/sandbox certification
environment and connection separately from the selected production connection; one is never
relabeled as the other. Both proofs must have completed within the previous 24 hours under
`booking-affiliate-referral-readiness.v1`. This window is capability-evidence freshness only;
it is not the probe lifetime, click-attribution window, data retention, or a general
provider-health promise. The reader requires an explicit `READ COMMITTED` transaction;
row locks then serialize each final currentness check with permanent revocation without
allowing an older repeatable-read snapshot to hide a committed revocation. The result
exposes only opaque evidence references.

This reader covers only `referral_round_trip`. Publication and agreement activation remain
blocked until equivalent two-part evidence exists for reservation lifecycle, stay completion
and accommodation revenue and the existing four-purpose assessment accepts all four.

## Remaining source-capability evidence storage

Migration 0220 adds the same two-part evidence boundary for `reservation_lifecycle`,
`stay_completion` and `accommodation_revenue`. One immutable certification row records a
successful isolated synthetic fixture for one capability and remains pinned to the exact
diagnostic probe, booking binding, property, destination, organization, connection and
adapter version. One immutable production preflight row records a documented authenticated
read for one capability and remains pinned to the exact production destination and source
configuration. Fixed capability-specific assertions and a globally unique evidence
fingerprint prevent one source check from being relabeled as another purpose. Permanent
preflight revocations preserve the old evidence.

These tables are validation inputs only. They contain no creator, agreement, click,
attribution, commission, payment or Finance journal association, and they do not make a
destination ready. Authorized commands still need to obtain and verify the evidence through
each adapter. A later reader must apply freshness, reject revoked or changed configuration,
require both matching rows per capability and then supply the three results alongside
`referral_round_trip` to the existing four-purpose assessment.

## Remaining source-capability production preflight command

Migration 0221 and the internal source-capability preflight command add retry identity to
the three remaining production evidence types. The command reauthorizes the exact hotel and
saved destination before invoking a server-owned adapter for one explicit capability. The
adapter must use a documented authenticated read and return the exact capability, current
connection and adapter version, bounded source references and a globally namespaced,
capability-independent identity for the underlying provider snapshot. Vayada hashes that
identity before storage; global uniqueness prevents the same source snapshot from proving a
second capability.

Concurrent retries run one adapter check. Reusing a retry key with another actor, capability,
destination or adapter configuration is a conflict. Unavailable, timed-out, mismatched or
malformed evidence records nothing. The command creates no reservation, inventory, payment,
creator, agreement, click, attribution or Finance record and does not grant readiness. The
diagnostic certification commands and the freshness-aware aggregate reader remain separate
required slices.

## Remaining source-capability certification command

The internal source-capability certification command completes the diagnostic writer for
`reservation_lifecycle`, `stay_completion` and `accommodation_revenue`. It reauthorizes the
hotel and exact destination, locks and rechecks the unexpired, unrevoked probe, and requires
exactly one bound booking that remains explicitly marked as an isolated affiliate-validation
fixture. A server-owned adapter then verifies one named capability against that exact probe
and booking with a bounded call. Scope, capability, booking identity and evidence references
must all match before the immutable certification is stored.

One probe may certify each capability once; concurrent retries perform one adapter check and
return the same certification. Expiry or revocation during verification prevents insertion.
The bound booking remains permanently excluded from the Finance affiliate journal. The
command creates no production reservation, attribution, readiness, payment or earning data.
The aggregate freshness-aware reader remains the next required slice.

## Aggregate destination tracking readiness

The Booking-owned aggregate reader applies the existing 24-hour evidence policy to all four
tracking purposes and then calls the existing `assessAffiliateDestinationTracking` domain
decision. Server-owned configuration supplies the exact diagnostic and production connection
plus adapter version separately for each purpose. A purpose contributes one healthy validated
item only when both its exact current certification and production preflight are present,
fresh and unrevoked. Missing, stale, revoked or configuration-mismatched evidence leaves that
purpose pending; success for another purpose cannot substitute for it.

The caller owns an explicit `READ COMMITTED` transaction. Destination, certification, probe
and preflight row locks serialize final currentness checks with permanent revocation, including
revoker-first fallback to an older current proof. The result exposes one opaque combined
reference per ready purpose and never exposes provider evidence payloads. It performs no
network call or write and creates no booking, attribution, agreement, readiness override,
payment or earning. Publication consumption remains a separate slice.

## Authorized destination readiness consumption

The private hotel destination repository can now evaluate the aggregate reader inside one
explicit `READ COMMITTED` transaction when a trusted server-owned source configuration is
installed. The destination and active property are locked with the evidence rows so a
concurrent revocation or property change cannot produce a mixed readiness response.

Only the exact current policy with one distinct, fresh, purpose-bound opaque reference for
each of the four purposes may be returned as validated. Malformed, partial, duplicated,
future or stale port results are redacted to the existing pending response. Without a current
source-selection provider, the production repository continues to report pending; request
payloads cannot supply configuration or readiness.

## Publication prerequisite composition

The internal Marketplace publication command can compose complete commercial conditions
with the Booking-owned aggregate reader inside its existing `READ COMMITTED` transaction.
It derives the destination from the locked draft, obtains source selection from a trusted
server port and retains the four opaque tracking references with commercial evidence in the
immutable published terms.

Missing configuration, commercial conditions or a tracking purpose blocks publication and
writes nothing. Pending purposes remain explicit; malformed port responses return a safe
`tracking_readiness_invalid` blocker rather than throwing or storing partial proof. The
default publication resolver remains blocking because the commercial-conditions and current
source-selection providers do not yet exist. This composition adds no HTTP publication route,
agreement or link activation, and no request payload can supply readiness.
