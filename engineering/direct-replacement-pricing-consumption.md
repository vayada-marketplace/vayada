# Direct booking consumption of replacement pricing (VAY-1543)

Status: implementation contract, not an activated booking flow. Base: repaired
pricing editor `0679c325e9` / PR #2073. Authority:
[replacement pricing](replacement-pricing-contract.md),
[draft policies](pricing-offer-terms-drafts.md), and VAY-1543's agreed Python-first
rules. Earlier occupancy-only exclusions and parallel-engine migration plans are
superseded. Python production remains untouched.

## Audit and concrete owners

Paths below are relative to the repository. Existing types are evidence of an
interface, not proof of a working replacement adapter.

| Boundary | Existing implementation | Required change |
| --- | --- | --- |
| Public property authority | `apps/api/src/routes/bookingWebPublic.ts`: `resolveTargetCheckoutProperty` | Resolve canonical slug and current public bookability server-side; do not accept body property/organization authority. |
| Public offers/calendar | Same file: `loadTargetCheckoutOffer`, `createTargetBookingWebCalendarRepository`; `apps/api/src/routes/aiHotelQuotes.ts` | Currently fail with `PRICING_UNAVAILABLE`; consume the approved snapshot through an owner port. |
| Physical room allocations | `packages/domain-booking/src/roomSelection.ts`: `parseBookingRoomSelection`; `apps/api/src/routes/bookingWebMixedQuote.ts`: `quoteTargetRoomSelection` | Existing allocations contain adult/child counts, not child ages; add a versioned age-aware selection before pricing children. Mixed quote is unavailable. |
| Approved PMS prices | `apps/api/src/domains/replacementPricingStore.ts` | Current `read` starts its own transaction and requires staff scope. Reuse complete publication decoding in a caller-transaction PMS owner port; do not forge staff context for public guests. |
| Room-night calculation | `packages/domain-pms/src/replacementPricingCalculator.ts`: `calculateReplacementRoomStay` | Reuse the same pure calculator used by the editor, one call per allocated room. It does not establish current database authority. |
| Policy/charge/payment evidence | `bookingPricingOfferTerms.ts`, `replacementChargeDeclarations.ts`, `financeReplacementPricingReadiness.ts`, `financeReplacementPricingSource.ts` under `apps/api/src/domains` | Read current published terms, confirmed charge evidence and executable Finance readiness through their owners. Publication readiness alone is not checkout acceptance. |
| Booking composition | `packages/domain-booking/src/replacementPricingEvidence.ts`, `bookingPromotions.ts`, `bookingAddonEconomics.ts` | Replacement owner-input/evidence contracts exist; the old promotion evaluator is disabled. Implement the agreed promotion/add-on/charge composition rather than reviving it. |
| Quote storage/read | `bookingWebPublic.ts`: `createTargetCheckoutQuote`, `loadTargetCheckoutQuoteSnapshot` | Both are unavailable. Persist and retrieve server-issued versioned evidence; never trust posted totals or policy snapshots. |
| Acceptance and receipts | Same file: `createTargetBookingWebCheckoutAdapter`, `withTargetCheckoutTransaction` | Preserve reservation, command replay, Finance, same-day, inventory, promotion redemption and notification ownership while binding new evidence atomically. |
| Amendments | `apps/api/src/routes/pendingBookingEdits.ts`; date-change path in `bookingWebPublic.ts` | Reprice a proposal explicitly; accept against the current booking revision and preserve original accepted evidence. |
| Staff preview | `apps/api/src/routes/pmsManualBookingPreviewCalculation.ts` | Replace the unavailable preset-price path with the same composition. Authorized manual overrides remain separate, explicit evidence. |

`apps/api/src/domains/replacementPricingSnapshot.ts` now shares
`parsePricingStorageSnapshot` and `readCurrentPricingSnapshot` with the pricing
store. The extraction is copied from verified Channex integration
`44da0edc63a071d043f6dc4d6418e2cd44997123`, preserving newer draft-policy work.
It rejects dangling heads, incomplete room sets and malformed sources; it does
not authorize access. Callers must authorize the property, hold its inventory
lock in the same transaction and check current owners separately. Channex job
leases and channel connections must not become public guest authorization.
No verified external-PMS pricing-authority adapter was found in these direct
paths. Booking's `pricing_authority_revisions` and `pricing_authority_heads`
record an explicit staff choice: `vayada`, `external` or `unconfigured`.
Missing state is unconfigured; no backfill infers authority from rates or channels.
Migration0202 stores immutable actor/organization/request history with a scoped
head. The owner command uses live pricing-manage authorization, expected-head
comparison and idempotency under the property inventory lock. Reads take that
same lock inside the caller's authorized transaction. Public access, active
ownership and provider readiness still require independent checks; only an
explicit Vayada choice can enter the forthcoming local-price adapter. Bind its
revision into the PMS source key, so changing authority invalidates quotes.
External choices stay unavailable until an external adapter is verified. UI and
route wiring must not silently select Vayada for existing properties.

`publicPricingAuthority.ts` now implements the internal public-access gate in a
caller-owned READ COMMITTED transaction. It re-resolves canonical identity after
the inventory lock, locks the choosing organization, public catalog/profile rows,
current owner/operator links and entitlements, and checks expiry against the
current clock. Only active, complete properties with fresh ready public profiles
and explicit Vayada authority pass. It returns the authority revision for the
subsequent source-identity adapter. It does not establish published-price freshness,
stay/calendar/inventory eligibility or executable payment readiness. Routes remain
unavailable until those checks and composition/acceptance are connected.
The gate targets locale-less canonical slugs, matching Distribution publication
reservation and the existing unique slug/locale index. Localized catalog slugs
are not booking URL identities for this adapter.

`publicPricingPublication.ts` composes the public gate with the complete current
publication and concrete PMS/Booking/Finance/charge owner ports. It rejects
unknown source/owner keys, missing publications, stale complete sources, inactive
rooms, changed offer policies, unavailable or mismatched Finance evidence and
mismatched charge declarations. The complete offer set includes linked ancestors.
Lock order is public authority/inventory/identity/catalog, room facts and rooms,
Booking terms, Finance settings/account/evidence, then the immutable charge read.
Public expiry is rechecked after owner reads. `booking.pms.publication.v2` binds
property, organization, authority revision, published revision and all three
current source keys. The returned object is internal composition input, never a
public response or permission to accept a stay. Routes remain unavailable.

## Selection and identity

A public request identifies the hotel by its resolved route, dates, selected
public offers, allocated guests and requested extras. The server binds the
canonical property and maps public offer identities to scoped room/offer IDs.
Do not infer an offer from a `flexible`/`non_refundable` label: multiple offers can
share cancellation kind, and meal/link identity is independent of that kind.
Persist the selected offer and policy revision together.

Use one `ReplacementStay.rooms` entry per physical room, with a unique selection
ID, actual adults and integer child ages at check-in. Keep stable selection IDs
across quote/acceptance; do not price a whole party at maximum room occupancy or
multiply one occupancy price by room count. Reject missing ages for a child;
never invent a default age from the old child-count field. An adult-only v1
adapter may be explicit, but must preserve exact allocations and offer identity.
A versioned public parser must bound request size, room count, stay length and
extras before reads/calculation; the current domain stay parser alone does not
provide all those public resource limits.

`replacementStayKey` binds dates, currency, allocations, ages, extras and promo
code. It is not authentication or a substitute for stored evidence. Bind the
public quote additionally to its server-issued reference, property, explicit
calculation version, complete owner revisions, issue/expiry times and acceptance
method. No client-supplied hash, source revision or cancellation snapshot is
accepted as owner evidence. Request keys use UTF-16 code-unit ordering rather
than locale collation for selection/add-on IDs. This is defined before the
replacement quote persistence adapter is introduced.

`publicPricingSelection.ts` implements `public-pricing-selection.v1` as a pure
Booking boundary. It bounds requests to 99 physical rooms, 99 guests per room,
366 nights, 99 distinct extras and quantity99 per extra; these are resource
ceilings, not inventory or capacity permission. IDs/promo codes are at most200
UTF-16 code units and public offer keys512. The eventual HTTP adapter must also
bound raw body bytes before JSON decoding. Only the server supplies property
scope and exact current public-offer mappings. Missing/ambiguous selected mappings
fail. Selected-person extras are rejected until their versioned input exists.
No public route or stored evidence is activated by this parser.

Selected-person add-ons are a known contract gap: `ReplacementStay.addons` has
quantity/dates but no selected-person identity. Extend the versioned input and
request key before offering that feature; do not silently price every guest.
Departure-date services remain possible when the add-on owner permits them.

`publicPricingRoomStay.ts` binds the versioned guest allocation to server-derived
`pricing-offer.v2` keys, hashes of the current PMS source identity, room and offer.
These keys are replacement-selection identities, not legacy Distribution offer
aliases. Discovery must derive them from the same validated publication; any
source/publication/authority change requires refreshing the selection. The
transaction adapter reuses the PMS calculator per physical room, preserving
selected meal, linked ancestor terms and every night's exact component amounts.
It returns `room_components` with evaluator version `booking.room-components.v1`,
not a checkout quote or grand total. Aggregate room/meal amounts enforce the same
18-digit minor-unit bound. Add-ons and promo intent remain in the bound stay for
later owner composition; currency conversion and stay/calendar/inventory checks
remain unavailable here. No public route is activated.

## Approved publication read

Implement a Booking-facing composition adapter in `apps/api/src/domains` using
PMS/Booking/Finance owner ports. Routes do not query PMS pricing tables. A PMS
port accepts the caller's transaction and a server-verified property scope;
its authority must be derived in that transaction, not supplied as `true` or
as a synthetic hotel employee. Keep staff authorization and Channex job authority
separate. A branded TypeScript value alone is not a runtime permission check.

Read the complete head, revision, room membership, source revisions and owner
references consistently. Only published revisions are eligible. Drafts, staged
policy candidates and abandoned new offers are never direct-sale sources.
Compare the current room/terms/Finance sources with the publication, validate
selected rooms and every linked ancestor, then invoke the existing owner checks
without weakening their staff-facing authorization. This requires a distinct
trusted consumption boundary, not removal of authorization from publication.

Acquire the existing property inventory coordination lock before PMS/Booking/
Finance reads, matching pricing publication order. Use caller-owned transactions
for acceptance; no nested transaction or independently committed readiness read.
The first adapter PR must document its concrete lock order alongside concurrent
publication, room closure, Finance changes and inventory reservation tests.

Map the seven Booking source keys explicitly: `pms` covers the published
revision and room-source identity; `terms`, `promotions`, `addons`, `charges`,
`finance` and `fx` cover complete owner input sets. The three PMS editor source
keys alone cannot stand in for all seven Booking revisions. Preserve each
owner's actual evidence identity rather than manufacturing placeholder strings.

Recheck the public property, operating eligibility, same-day policy and
property-local cutoff, materialized calendar, inventory and active ownership.
A minimum advance of zero does not bypass same-day controls; auto-open settings
are not a substitute for available materialized inventory. An external-authority
or unknown-authority decision returns unavailable unless the corresponding
verified adapter can provide current evidence. Never fall back to old room base
rates or Channex values when replacement evidence is missing.

## Composition, money and persistence

PMS resolves room/child components and the selected offer's meals. Booking adds
promotions, selected extras and mandatory charges through their existing domain
owners. Preserve the agreed order: linked/NR room adjustment before meals;
last-minute discount on room; optional code stacking on discounted room plus
eligible extras; nonstack compares independent candidates with last-minute
winning ties. Booking-validity and arrival windows remain independent and
conjunctive. Do not derive promotional eligibility from the checkout date alone.

`replacementDiscountComposition.ts` implements the pure `booking.discount-components.v1`
arithmetic for already eligible, same-currency owner inputs. Last-minute applies
to each room component, code applies once to eligible rooms plus eligible extras,
and stacked code subtracts only those rooms' last-minute reductions from its basis.
Nonstack chooses the greater total reduction, with last-minute winning ties.
Percentages round the remaining price half-up in integer minor units, matching
the agreed reference arithmetic; fixed amounts cap at their applicable basis.
Meals and other charges are outside this input. Explicit null discounts and zero
eligible extras are required; missing owner decisions fail rather than defaulting.
This arithmetic does not establish date eligibility, switches, usage, targeting,
current source revisions, complete quote money or acceptance. It is not yet wired
to public pricing without those owners.

`replacementPromoCode.ts` reads requested-code eligibility from current Booking
settings and `promo_definitions`, preserving Python's independent inclusive
booking/arrival windows, usage limits, minimum value and room targeting. Caller
must already authorize the property and supply the owner-derived minimum-booking
basis. It locks inventory, property, settings/location, selected room scopes and
all property codes, then derives the property date from the current database clock.
Saved decimal amounts use the Booking currency with exact minor conversion;
nonrepresentable fractions fail. The source key binds currency, timezone, local
date and all saved code state. Returned eligible selection IDs feed the discount
basis. This is neither usage redemption nor the complete promotions source;
last-minute/other promotions and final quote/acceptance composition remain required.

Migration0203 adds Booking-owned immutable room last-minute revisions and scoped
heads, because the replacement schema had no room override setting. Missing head
means inherit, matching Python's absent room config; an explicit enabled/empty
policy also restores inheritance. `roomLastMinuteStore.ts` requires live PMS
pricing-manage authority, exact room scope, expected revision and an idempotent
request. Actor/organization/history persist; retries reauthorize without resetting
the current head. Tiers reject overlap and unrepresentable percentage precision.
Hotel settings remain in Booking's existing settings owner; no room attributes or
retired PMS rate rules are repurposed. The current reader follows separately.

The existing replacement promotion input represents last-minute/code rules,
not the full agreed early-bird/midweek/free-night feature set. Those need concrete
owner rules and evidence before activation. Per-offer accepted payment methods
are also absent from `ReplacementOfferTerms`; global Finance methods do not
prove an individual rate permits a method. Extend those owner contracts rather
than silently dropping the configured restrictions.

An explicit zero/empty owner result is different from a missing adapter. Missing
promotion, add-on, charge, FX or payment evidence cannot become a default zero,
no-discount, exchange rate1 or payment-ready result. The publication's
all-mandatory-charges declaration does not establish selected-stay tax amounts.

Keep currency-aware integer minor-unit strings throughout the new evidence.
`BookingPriceCalculation`, mixed snapshot money helpers and legacy quote
serialization contain fixed-scale/two-decimal or `Number` conversions. They are
not a safe adapter for arbitrary replacement currencies/amounts. Introduce a
versioned public representation and accepted snapshot decoder; explicitly reject
unsupported currency/amounts until each downstream consumer supports them.

`ReplacementPricingEvidence` currently aggregates room/meal lines without
nightly provenance and has no separate evaluator-version field. Before persisted
acceptance, extend the versioned Booking envelope to retain per-room/night
amounts, selected terms, owner/calculation revisions, applied adjustments and
meal evidence needed by confirmation, revenue, refunds and amendments. Do not
silently replace historical v1 evidence or assume `version: pricing.v2` alone
identifies every future calculation change.

`stored-pricing-quote.v1` now wraps the bound stay and aggregate evidence with
an explicit evaluator version, payment method and complete room/night records.
The decoder validates exact minor strings, selected terms, meal plans, source
references and nightly/aggregate conservation. It validates history at issuance;
fresh status additionally checks current owners, request, method and evaluator.
This is a server-storage format, not posted quote authority. Database writes,
owner composition and executable payment validation remain integration work.

Persist the exact accepted total, due-now and due-later amounts with the selected
payment method and Finance evidence. The agreed example is360 at30% →108/252 on
the final total. Deposit execution is currently unavailable in replacement
Finance readiness; displaying or staging a deposit policy cannot enable it.
Mixed offers with incompatible executable payment/cancellation terms must be
explicitly rejected until a supported composition policy is implemented.

## Quote acceptance and historical behavior

Search estimates are not reservation authority. A quote is server-stored and
expires. Acceptance resolves public access, reserves/replays the existing
idempotent command, loads the exact stored quote, and checks binding/expiry and
current owners under the same transaction as inventory/promo consumption and
booking creation. Use a fresh server clock at validation, not a client timestamp.
Any changed owner revision or total requires a new quote and renewed consent;
never silently accept a recalculated price from an old quote reference.

Preserve the existing receipt ordering: an already accepted command can return
its stored result through current authorization checks without repricing against
new rates. Reusing its key with a changed command fails. A failed fresh acceptance
must roll back quote acceptance, inventory, promotion usage, price evidence and
outbox effects together. Keep payment/provider and notification side effects
within their established command/outbox boundaries; no duplicate charge or email
on retry. This contract does not authorize real payment or notification tests.

Confirmation reads accepted evidence. Later rate/policy edits do not recalculate
an existing booking. Amendments store a new proposal and explicitly accepted
replacement evidence; retain the original history and capped original discount
rules. Booking revision, permission and reservation-credit checks remain owned
by the amendment/inventory domains. Mixed-room activation stays gated until all
acceptance and lifecycle consumers support the same allocated evidence.

## Bounded implementation order and acceptance

1. Versioned public allocation/offer mapping and currency-safe evidence envelope;
   reject missing child ages, unknown offers, malformed extras and unsafe amounts.
2. Caller-transaction approved-publication owner read with real PostgreSQL tests:
   tenant/publication scope, no draft visibility, complete room/ancestor coverage,
   stale owners, external/unknown authority and publication/closure concurrency.
3. Booking composition with concrete promotion/add-on/charge/Finance/FX owners.
   Cover independent windows, stack/nonstack, selected-person/date extras and
   executable full/deposit schedules; unsupported owner capabilities fail closed.
4. Server quote persistence and readback, expiry/request/source identity, current
   authorization and exact idempotent acceptance with inventory/promo rollback.
5. Search/manual preview/checkout/confirmation/amendment integration, then real
   signed-in/public synthetic end-to-end checks before runtime enablement.

Every slice uses the same room calculator. Required downstream fixtures include
100/130/155 occupancy; one versus two allocated rooms; mixed rooms315 including
breakfast; NR breakfast184.50; nonstack80 rather than82; and final-total deposit
108/252. Use the full agreed fixture inputs, not guessed totals. Add stale-source
races, accepted retry after repricing, expiry, room closure/cutoff, invalid ages,
JPY/KWD, unchanged historical evidence and no double meal/promo charge.

Current reset tests remain until the corresponding replacement slice has all
owner and acceptance evidence. A successful editor publication or calculator
unit test is not authorization to remove every `PRICING_UNAVAILABLE` guard.
