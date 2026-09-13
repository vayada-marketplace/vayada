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
fail. V1 rejects selected-person extras; the v2 extension below supplies explicit references.
No public route or stored evidence is activated by this parser.

Selected-person add-ons use the v2 extension described below. Old v1 entries
retain quantity/dates without inferred participants; never silently price every guest.
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
retired PMS rate rules are repurposed. `replacementLastMinute.ts` reads the current hotel and room choices under the
caller transaction. The database clock supplies property-local lead days. Hotel
off suppresses every room; room off opts out; nonempty room tiers override; empty
or absent room tiers inherit. It returns exact basis-point decisions and the saved
stacking choice, binding hotel/room heads/timezone/local date into source identity.
Missing/malformed hotel state and active generalized promotions remain unavailable
until their owner exists; this is not calendar/inventory or full quote approval.

The existing replacement promotion input represents last-minute/code rules,
not the full agreed early-bird/midweek/free-night feature set. Those need concrete
owner rules and evidence before activation. Per-offer accepted payment methods
now use explicit `payment.acceptedMethods` in `ReplacementOfferTerms`; historical
absence supplies no permission. Global Finance methods alone do not prove an
individual rate permits a method.

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

`replacementAddons.ts` reads current Booking add-on definitions under the
caller-authorized transaction. It preserves exact same-currency unit prices,
all four saved pricing models, visibility/status, quantity/guest limits,
lead-time text and property/partner economics. Missing metadata limits use the
existing writer/read-model defaults (quantity1, no guest limit). Owner rows and
parent property remain locked; complete definition state binds source identity.
An explicit empty selection returns owner evidence, not an inferred zero total.
Selected-person/date eligibility, amount composition, executable lead-time rules,
FX and partner payout allocation remain separate obligations. Python reference:
`apps/pms-api/app/services/booking_service.py:_compute_addon_total` and its
`test_addon_pricing.py` fixtures; its unknown-ID skipping and 1:1 FX fallback are
not copied. Missing selected definitions or precision loss return unavailable.

Selected-extra input now uses `public-pricing-selection.v2` with
`addon-selection.v2` entries: id, quantity, dates and explicit people (null or
room selection/kind/index references). References identify slots in the ordered
adult/child allocation, not names. Child order is bound into request identity when a v2 extra is present;
selected-person order is irrelevant. Empty-extra requests retain the existing
order-insensitive room identity, regardless of public transport version. Existing v1 stays retain historical decoding
and keys; v1 extras do not gain inferred participants. At most99 participants per
extra; dates remain within arrival through departure pending owner eligibility.
The concrete amount adapter requires v2 extras. Quantity means service units;
per-guest models require quantity1 and explicitly selected participants. Saved
unit tariffs apply equally to selected adults and children; different child
prices require a new owner contract. Nightly services exclude checkout; one-time
services allow at most one date, including checkout. Free-text lead-time rules
cannot be treated as executable eligibility.

`lockReplacementAddonAmounts` now combines a bounded v2 selection with locked
current definitions in the same authorized transaction. It returns exact bigint
unit × quantity × selected-people × service-days components, source revision,
request key and definition/economic snapshots. Null nightly dates mean all stay
nights; explicit dates count only selected nights. One-time extras have at most
one scheduled date, optionally checkout. Quantity limits apply to service units;
per-person models require quantity1 and at most the saved guest limit. For
non-person services a saved guest limit applies to the whole allocated party.
Nonempty free-text lead time is unavailable until an executable owner rule exists.
Missing owners, v1 extras, mismatched models, FX needs and overflow fail closed.
This subtotal does not authorize capacity, payouts or quote acceptance.

`lockPublicPricingComponents` now connects the public current room/meal reader,
selected-extra amounts, current LM policies and requested code eligibility in a
single caller transaction. Room-type deduplication is only for policy lookup;
physical room selections retain separate amounts. Promo minimum value preserves
Python's room-after-LM plus extras basis (also in nonstack mode), excluding meals.
Actual discount selection still uses the corrected independent nonstack comparison.
Invalid requested codes fail; absent code is explicit intent. Sources bind current
LM and code evidence; output retains owner snapshots and request identity.
Public authority and property-local day are rechecked after owner waits. The
result is a subtotal before mandatory charges, with partial component sources;
it must not be serialized as a complete quote or used to infer missing charge,
FX, deposit, calendar/inventory or generalized-promotion execution.

`composeReplacementSettlementAmounts` implements arithmetic on resolved,
same-currency, disjoint charge amounts and an already eligible payment schedule.
Included amounts are not added twice; excluded amounts increase the final total.
Property-collected portions are reserved from online collection, including those
already embedded in the subtotal. Included allocations cannot exceed subtotal.
Full online payment collects the remaining online-collectible amount; pay at
property defers the total. Deposits round half-up on the entire final total:
360 at30%=108 now/252 later. A deposit exceeding the online-collectible portion
is unavailable rather than clamped or redirected. This does not establish
selected-stay tax/fee ownership or enable deposit execution in Finance. Zero-total
booking acceptance remains unsupported. Charge basis evidence is preserved, not
verified, by this pure helper; current-owner and per-rate method checks must
precede its eventual use in complete quote composition.

Fixed mandatory-charge policies use `booking.fixed-charges.v1`: explicit currency
and complete list of active rules (empty explicitly means none). Each rule has
stable id/name, integer minor-unit amount, unit (booking, room, night, room-night,
person or person-night), inclusion and collection flags. Person rules require an
explicit minimum age0..18; adults qualify, children use actual age at check-in.
Other units require no age threshold. Nights exclude checkout; physical rooms
are counted separately. Rates are hotel inputs, never jurisdiction defaults.
Percentage/compound taxes, exemptions beyond age, seasonal/room targeting and
maximum taxable nights require distinct contracts and are rejected by this schema.
`calculateReplacementFixedCharges` returns calculated amounts, quantities, rule
snapshots and stay/policy-bound basis identity. It does not prove current policy
ownership. Included amounts remain annotations; the settlement combiner checks
that they fit the final subtotal. Durable current policy ownership follows this
calculation slice; publication inclusion confirmations are not converted silently.

Migration0204 stores Booking fixed-charge policy revisions and current heads.
`createFixedChargePolicyStore` requires live pricing-manage authorization,
expected revision and an idempotent request; immutable actor/organization history
records every policy replacement. Retries reauthorize without resetting the head.
`lockCurrentFixedCharges` reads the current explicit policy and calculates charges
inside the caller-authorized property transaction. No head means unavailable;
an empty saved policy explicitly returns zero fixed charges. Source and basis
identity include current policy revision and exact selected stay. This does not
claim coverage of unsupported tax types or replace public visibility/Finance
checks. Connecting this fixed-rule owner to complete quotes requires explicit
coverage and removal/replacement of the older all-included publication gate.


A publication may explicitly adopt `booking.fixed-charge-policy.v1:<revision>`
as its charges owner reference. This selects the entire saved fixed-rule policy
(including explicit none), not a default inferred from the older inclusion
confirmation. Draft/publish/public reads require that exact current property
policy revision and currency; editing the policy invalidates the publication
until republished. Unsupported rule types remain unavailable. The legacy
all-included declaration remains readable but cannot supply charge amounts.

`lockPublicPricingChargeTotals` joins current public components with the adopted
policy's selected-stay amounts under one READ COMMITTED transaction. It returns
subtotal, total, included/additional and online/property collectible portions,
plus request/source/basis provenance. It adds excluded charges after discounts,
never adds included charges twice, and rejects included allocations above the
subtotal or invalid money. Authority and property-local day are rechecked after
charge reads. This internal amount result is not a payment schedule, complete
quote, inventory reservation, legal tax certification or checkout approval.


Selected payment composition requires explicit `payment.acceptedMethods` on each
selected offer's current Booking terms: nonempty, unique `card` and/or
`pay_at_property`. Absence preserves historical terms decoding but supplies no
method permission. The authorized terms writer stores the setting in the same
immutable revision; changes require republishing as other terms changes do.
The chosen method must also be currently executable in Finance. Only selected
offers determine rate permission; ancestor/unselected terms do not grant it.

`lockPublicPricingPaymentAmounts` composes full-payment terms only. Card collects
the online-collectible portion now, leaving property-collected fees for later;
pay-at-property defers the total. Deposits and mixed cancellation terms fail
closed. Preserve selected terms/revisions, method, Finance evidence and a
method-bound calculation identity. This remains an internal result, not an
accepted quote or permission to charge a provider. Quote persistence, remaining
owner evidence, inventory and atomic acceptance still precede route activation.


The current quote assembler creates `stored-pricing-quote.v1` exclusively from
locked public payment amounts. Lines preserve gross room/meal/extra amounts,
negative discount contributions and only additional charge contributions;
included charges remain in the separate calculation details so totals do not
count them twice. Repeated physical rooms retain nightly records while selected
terms are deduplicated by room type/offer. Preserve charge rules/quantities,
extra selections/economics, discount decisions and payment calculation identity
alongside the validated quote for historical downstream use.

Same-currency composition explicitly records a versioned no-conversion source
bound to currency and the verified component sources. It does not fabricate an
exchange rate or enable cross-currency quotes. Issue time comes from the database
after owner reads. The internal caller supplies a bounded lifetime (1–900 seconds),
capped at the next property-local midnight; a local-day change during reads is
unavailable. Stored price evidence is not inventory or checkout acceptance.


Migration0205 stores immutable replacement pricing quote records separately from
legacy checkout sessions, avoiding old amount serializers and conversion jobs.
Issuance resolves current public authority before request replay. Request keys
are property-scoped and bind the canonical selection and payment method; an
identical retry returns the original quote without repricing or extending expiry.
Changed input conflicts. Current organization scope is required for replay and
readback. Quote amounts are historical records, not a fresh eligibility promise.
The stored envelope is decoded and bound to the record's property/id on read;
calculation details are retained server-side as archival JSON, not public output
or independently validated input to settlement. No quote acceptance status is
fabricated; atomic acceptance will reference this record after fresh checks.
