# Replacement pricing contract (VAY-1539)

Authority: [agreed rules and owners](https://linear.app/vayadacom/document/agreed-pricing-rules-and-concrete-implementation-ownership-243a6a868936).
This supersedes the older occupancy-only contract. Stack after VAY-1546 deletion;
no runtime fallback, routes, persistence, evaluator or provider activation here.

## Money and room modes (VAY-1554)

All amounts are canonical integer minor-unit strings, never JS floating-point
money. Currency vocabulary comes from runtime ICU; scales use ISO accounting
overrides where ICU display-rounding defaults differ (VAY-1925). Unknown codes fail. Store currency alongside amount. Scale-0 JPY, scale-2 IDR,
and scale-3 KWD are representable; provider support is a separate adapter gate.
Amounts are bounded to 18 digits for validation; calculation overflow must fail.
Do not pass these objects to old scale-2 interfaces without explicit conversion.

One room-price mode per offer: flat, occupancy table, included-guests adjustments,
or per-person, consistently across base/month/season rows. Explicit final date
overrides are the exception and may intentionally flatten the price. Unknown/extra fields fail. Switching modes replaces the entire
price object; inactive fields cannot silently survive as active rules. Occupancy
arrays encode exactly one row for each adult-equivalent count 1..adultCapacity.
Equal amounts at different occupancies are legal; sparse/missing rows are not.
Included-guests adjustments are relative to one base price, including reductions
for fewer guests. The base row is a fixed zero delta. Percentages use integer
basis points (1000 = 10%); round half-up once after each applied adjustment.
A nonpositive effective room amount is unavailable, not a fabricated free rate.

Parsers validate configuration only. Tests are contract-boundary tests, not proof
that the future VAY-1542 evaluator or a connected OTA calculates prices correctly.

## Calendar, guests and linked offers (VAY-1555)

Snapshots are scoped to one property/room/currency and revision. Links cannot
escape that snapshot. IDs/terms revisions are opaque owner references; storage
must verify tenant scope and current revisions, not trust client identifiers.
Months are 1..12; weekdays are ISO Monday=0..Sunday=6. Exact dates are ISO dates;
stays use checkout-exclusive nights. Seasons use inclusive recurring month/day
ranges, can cross New Year, and cannot overlap (including Feb29 in leap years).
Feb29 rules only match Feb29, never Feb28. Gaps are legal configuration but mean
unavailable if neither month nor base supplies a price. Labels/tiers persist.
Date override > season > month > base; weekday adjustment follows except for a
final date override. Linked dateOverrides are explicit final prices; clearing
one resumes the parent's room component plus link adjustment. Inherit only the
room component, never the parent's meal charge. The offer's own meal is added once.

Children use supplied integer ages at check-in, never guessed birth dates. At
least one actual adult accompanies a room. Ages at/above adultFromAge count as
adults for tariff/capacity; younger children use contiguous bands and separate
nightly supplements, do not occupy included-adult tariff places, and can explicitly
be excluded from total capacity (e.g. infants). max children still counts all
submitted children. Meal bands align exactly with child-policy bands. This
explicit initial allocation policy must be visible in the future editor.

Restrictions default to inheritance on linked plans; independent plans own rules.
Own date rules override recurring seasons then defaults. Minimum is read at
arrival; maximum is the tightest across occupied nights. CTA/CTD use actual
arrival/departure dates; stop-sell applies to each occupied night. Clearing an
own restriction policy switches to inherit, never silently resets to unrestricted.
Exact/nonexistent dates, duplicate rows, cycles and overlapping seasons fail.
Terms revisions reference full cancellation/payment/deposit terms supplied by
owners; this snapshot does not pretend a terms ID validates the policy contents.

## Booking evidence and owner inputs (VAY-1556)

`parseReplacementStay` validates public selection shape, real stay dates, guest
ages and exact fields. PMS validates actual capacity and selected offer scope.
Booking binds all selections to a deterministic request key and seven owner
revisions. Each revision covers the complete selected input set, not one row;
owner adapters must atomically read consistent snapshots and verify tenant scope.
`replacementEvidenceStatus` checks trusted evaluator output for staleness and
money conservation. It is NOT a parser or authorization check for client quotes.
Checkout must load server-stored evidence and revalidate all owner revisions,
availability and promotional usage under its reservation transaction. Persistence
stores immutable copies of accepted evidence; amendments create new records.

Add-on selections preserve quantity and explicit service dates; null means the
owner-defined whole-stay/default schedule. Dates must fall from arrival through
departure inclusive (departure services are legal); owners additionally enforce
unit-specific rules such as excluding checkout for nightly charges. Flexible
cancellation reuses the existing validated full terms contract, including partial
refund tiers, no-show penalty and descriptive text, rather than reducing it to
one deadline. Selected add-on dates are part of the immutable request binding.

PMS owns configuration. Booking owns cancellation terms, promotions, add-ons and
accepted stay evidence. Finance supplies payment capability and deposit readiness;
mandatory-charge owners supply confirmed totals/basis evidence (including zero).
FX owner supplies observed/expiry evidence and positive rational conversion rates;
no missing cross-currency pair becomes 1:1. Ratios convert source minor units to
target minor units, including scale differences; round half-up per component.
Owner port inputs are validated domain objects, not untrusted JSON. Their future
adapters must validate policy ranges, windows, scope, FX pair coverage, tax bases
and evidence references before returning them. Merely matching opaque IDs is not
proof of payment readiness, cancellation meaning, or mandatory-charge correctness.

Last-minute tiers use the smallest qualifying throughDaysBeforeArrival, property
local booking/check-in dates, hotel enablement plus room inherit/disable/override.
Promos use independent inclusive booking and arrival windows; stay window means
check-in. Empty roomTypeIds selects none; null selects all. No stacking compares
independent eligible totals (tie: last-minute). Stacking applies last-minute to
room, then code to room plus eligible add-ons. Meals/mandatory charges are excluded
from that promo basis. NR adjustments apply to room including guest supplements
before meals; NR-only starts at its configured price. Deposits use the final total.
Amendments preserve the original discount amount, capped at the new eligible basis.
Tax/charge owners determine discount effects before confirming charge evidence;
included taxes are annotations, not additive lines. Additive charges enter totals
once; collection timing is reflected in dueNow/dueLater. Terms and FX snapshots
remain attached to accepted evidence. No evidence is sent as provider IDs or raw
configuration pools to public consumers.

The executable examples assert agreed minor-unit arithmetic (184.50, 510, 315,
80 vs 72, and 108/252). They deliberately do not claim an implemented evaluator,
calendar precedence, promotion eligibility, FX feed, checkout or OTA integration.
VAY-1542 must run these same expected outcomes against the real evaluator and add
eligibility, calendar, restriction, child allocation, zero and overflow scenarios.

## Storage (VAY-1540)

Property-scoped heads point to immutable, complete revisions. Each revision owns
one currency, full validated room configurations, and opaque references to the
Booking/Finance/FX-owned controls. Room snapshots retain all offer IDs and terms
revisions. No owner policy is copied into a second domain's mutable tables.
Drafts are separate; a draft cannot change an accepted revision. Writes replace
a complete snapshot: callers compose omitted edits from the prior revision;
empty optional arrays explicitly clear them. No inactive tariff data is revived.

The storage adapter requires a transaction-bound guard that authenticates the
actor/organization/property scope and locks all relevant source revisions. It
must return current room/guest/currency and owner policy revisions, or deny.
The same transaction compares expected sources, inserts the immutable revision,
advances its head and writes platform audit/domain/outbox evidence. Currency
changes supply a complete converted snapshot plus FX owner evidence through that
guard; the adapter never treats a currency label change as conversion. VAY-1541
owns route authorization, editor patch composition, preview and publish commands.
No runtime caller is wired by these storage slices.

## Draft publication binding (VAY-1559)

Editor publication must pass `save.draft` with the saved draft ID and revision,
in addition to its complete snapshot, base revision and source revisions. Storage
compares all five under the same property lock as the active-head/effects write.
A changed or missing draft fails stale without publishing. A successful retry
replays the recorded result even if the draft or active head later changes; it
is a receipt for the original publication, not a claim of current freshness.
The draft binding participates in the request hash. Draft reads expose their
saved source revisions so callers need not substitute newly read evidence.

The unbound save remains an internal complete-snapshot primitive; editor routes
must never omit the draft binding. Concrete owner/auth/FX guard adapters and
preview orchestration remain VAY-1541 prerequisites before any runtime wiring.

## Live identity authorization (VAY-1560)

`lockReplacementPricingAuthorization` consumes trusted RequestContext and the
same property/organization/actor scope as storage, within its transaction. Read
uses `pms.rooms_rates.read`; mutations use `pms.rooms_rates.manage`, following
the current staff-access contract rather than broad compatibility permissions.
It rechecks active identity records, canonical and PMS property links, assigned
property scope, role grants and validated staff overrides. Disabled catalog
profiles deny; incomplete/private profiles remain editable. The canonical PMS
inventory lock comes first. Authorization row locks remain until transaction
end; the organization lock also serializes new FK-backed entitlement rows.
Entitlement applicability is evaluated using the database clock after locking.

This helper supplies only the identity portion of the required storage guard.
It does not validate room configurations, Booking terms, Finance readiness,
mandatory charges or FX evidence. Those owner adapters and route-policy checks
remain mandatory before exposing pricing commands. No routes are wired here.

## Booking offer terms owner (VAY-1561)

Booking owns immutable replacement offer terms and a current pointer scoped by
property, room and offer. This is the single writer for replacement commercial
terms, independent of retired pricing-shaped guest-policy bundles. Preserve the
full cancellation policy and requested payment/deposit schedule from the agreed
`ReplacementOfferTerms` contract. These settings express the offer's requested
schedule; Finance still owns capability and deposit readiness approval. Saving
terms cannot authorize payment execution or imply publication readiness.

The command uses real transaction-bound identity authorization and a PMS-owned
room-scope adapter, then compares the expected current revision. Server-issued
revision IDs, request identity, current pointer and audit/outbox effects commit
together. Old terms remain immutable when an offer changes. The Booking read
port accepts exact property/room/offer/revision references derived from the
complete proposed pricing snapshot, under the caller's authorized property
transaction. Missing or superseded references fail; callers cannot replace
those references with an empty client-supplied list. Accepted bookings continue
using their frozen evidence rather than requiring current policy versions.

No HTTP route, editor, Finance approval or complete publication guard is wired
by this owner-storage slice. Replacement preview/publication consumes this owner
port together with all other required owner evidence before becoming available.

## Finance method readiness adapter (VAY-1541)

`lockFinanceReplacementPricingReadiness` reads existing Finance-owned settings,
provider capability and accepted execution evidence in the caller's authorized
property transaction. It binds the result to the proposed replacement pricing
revision, currency and exact verified Booking terms revisions. It does not read
old PMS prices or invent a v1 currency revision. Settings, the selected provider
and accepted execution evidence remain locked until transaction end.

Pay-at-property can be available independently of card. Card requires Finance's
existing currency gate and exact current provider/property execution evidence;
revocation or capability changes suppress it. Unsupported selected methods do
not become aliases for supported methods. At least one verified method is
required. Currency mismatch fails without relabeling settings or converting data.

Deposit schedules return `deposit_execution_unavailable`: the current execution
contract does not prove split-payment support. VAY-1543 must implement and verify
that execution before Finance can approve deposits. The evidence ID covers the
locked sources; consumers must compare it on reuse. This is method capability,
not proof of checkout, collection timing or complete publication readiness.
The caller verifies terms through Booking and pricing through PMS before use;
the adapter is not a parser for client-supplied approval evidence. No new Finance
settings writer, HTTP endpoint or complete pricing guard is wired in this slice.

## Mandatory-charge inclusion declarations (VAY-1667)

`createReplacementChargeDeclarationStore.confirm` records the explicit PMS
declaration `all_mandatory_charges_included` against the commercial contents of
a saved replacement draft. It reads the draft under live authorization and PMS
locks, checks draft/base revisions, active property-owned rooms and current
Booking offer terms, then atomically writes immutable evidence, audit and outbox.
No missing declaration is interpreted as zero charges or calculated tax evidence.

The fingerprint includes currency, complete room pricing configurations (including
pricing and terms revisions), owner references and source revisions. Only the
`charges` key in owner references and source revisions is excluded so attaching
the declaration does not invalidate itself. Other price/source changes require a
new explicit confirmation. The stored draft ID/revision records the confirmation's
origin; exact idempotent replay returns that historical receipt, not renewed validity.
`lockReplacementChargeDeclaration` verifies the exact property, ID and commercial
fingerprint inside a caller-authorized transaction.

This evidence states that no extra mandatory collection is needed; it does not
calculate taxes or additive charges. The full publication guard must still validate
live non-charge owners, Finance readiness and FX evidence. Routes, additive charge
configuration and publication wiring remain follow-up work. Integration tests seed
the saved-draft boundary and exercise real local PostgreSQL authorization, Booking
terms and charge confirmation; they do not represent a deployed hotel confirmation.

## Complete PMS currency conversion (VAY-1878)

`convertPricingConfigurationCurrency` converts a complete validated room snapshot
with explicit `PricingConversionRate` evidence. Rates express target minor units
per source minor unit (including scale differences); integer arithmetic rounds
half-up per component, symmetrically for negative fixed adjustments. Evidence
uses canonical UTC ISO timestamps (`Date.toISOString()` format), a positive
bounded ratio, matching distinct supported currencies and a valid window at the
trusted caller-supplied time. An explicitly observed 1:1 ratio is legal; missing
FX never becomes 1:1. Overflow and positive tariffs rounded to zero fail.

Conversion covers all four room modes, all calendar layers, fixed adjustments,
linked date overrides, child supplements and both meal charging models. It keeps
percentages, restrictions, dates, terms, links, capacities and identities and
advances the pricing revision once without mutating the source.
`isCompletePricingCurrencyConversion` verifies the complete same-property room
set and exact converted contents; missing rooms, relabels, partial conversions,
revision mismatches and unrelated policy edits fail.

These functions prove PMS arithmetic only. They do not authenticate FX provenance
or caller scope, convert separately owned amounts, mutate settings or authorize
`PricingStorageGuard.allowCurrencyChange` alone. The authoritative FX adapter,
Booking/add-on/charge/Finance conversion and atomic publication remain required.
Production Python and accepted booking evidence are unchanged. Unlike Python's
mixed-room failure path, the new conversion never returns a relabeled room after
a missing exchange-rate failure; approved exact minor units also replace Python's
floating arithmetic and legacy IDR scale convention.

## Trusted FX observations (VAY-1925)

`createReplacementPricingFxReader` is a server-owned reader for the same
ExchangeRate-API open endpoint used by Python. It uses a fixed HTTPS origin,
rejects redirects and bounds requests to 10 seconds and 128 KiB. A successful
response must match the provider/base currency, contain an explicit requested
pair, and remain inside its observation/update/EOL window at consumption. Validity
is capped at 24 hours after observation. Errors return unavailable, never 1:1.

Node 24+ JSON reviver source text preserves numeric tokens before binary floating
rounding. Decimal/exponent rates become reduced BigInt ratios including source
and target minor-unit scales; ratios exceeding the existing 18-digit bounds fail.
A stable evidence ID binds provider, pair, exact ratio and observation/expiry.
The reader caches by base until expiry, coalesces requests, and cools down failed
fetches for one hour. It never returns stale evidence during an outage.

SIX List One (published 2026-01-01) exposed 16 ICU display-scale differences. The
shared pricing helper now explicitly uses ISO accounting scales for these codes,
including IDR=2 and IQD=3; the others are recorded with regression tests. This
corrects the previously documented scale promise rather than changing its meaning.

Fetch observations outside property database locks. This adapter does not persist
FX history, authenticate property access, convert separately owned amounts or
authorize publication. The final transaction must still validate observation expiry
and exact evidence references together with all other owners. Future consuming UI
must show `REPLACEMENT_FX_ATTRIBUTION`; raw-rate redistribution is not exposed.
Provider reference: https://www.exchangerate-api.com/docs/free. ISO reference:
https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml.

## Immutable FX ledger (VAY-1926)

`createReplacementPricingFxStore.observe(from, to)` fetches through the trusted
server adapter before acquiring a database connection, then records the exact
observation in `finance.pricing_v2_fx_observations`. This global reference ledger
stores provider, stable ID, pair, exact ratio, currency scales, observation/expiry
and database receipt time. Concurrent or repeated collection deduplicates by ID;
update, deletion and truncation are prohibited. The immutable record is the
observation audit trail, not a pricing publication event.

`lockReplacementPricingFxObservation` verifies an exact ID and pair inside the
caller's authorized transaction. It checks current currency scales, recomputes
content identity and uses `clock_timestamp()` for freshness. Immutable rows need
no row lock; transaction-start time must not extend their validity. Expired
observations remain available as historical database records but cannot approve
new pricing. The content hash detects mismatches; it is not a signature or a
replacement for the server-owned ingestion boundary.

The writer accepts currency pairs rather than arbitrary rate payloads. Both
insertion and verification use database wall time, so application clock skew
cannot admit future or expired observations. A rate that expires after insertion
can remain in history even if the final lookup correctly returns unavailable.
The publication caller must recheck expiry at the mutation boundary and verify
property scope, complete conversion and every other owner. Collection alone does
not authorize a currency change, rewrite accepted bookings or publish prices.

## Currency conversion at the storage publication boundary (VAY-1927)

When an existing pricing revision changes currency, `createReplacementPricingStore.save`
now requires the proposed `ownerReferences.fx` to identify an exact, currently valid
persisted observation for the old/new pair. It checks every prior PMS room against
the complete conversion using database wall time, then requires the additional
`allowCurrencyChange` owner guard. Valid PMS arithmetic alone cannot approve amounts
owned by other domains. The complete live source/authorization guard remains required
before wiring routes; injected test guards are not evidence of that integration.

After revision, room, head, audit and outbox writes, storage rechecks the immutable FX
observation immediately before returning to commit. Expiry during those writes rolls
back the whole publication and preserves its draft. This is validity at the final
transaction check, not a promise about elapsed time during PostgreSQL commit. Exact
successful request replay returns its historical receipt without a new conversion or
new effects, even after expiry. Draft binding, source/base concurrency checks and
same-currency writes retain their existing behavior. Provider fetching stays outside
this transaction; there is no refresh or substitute rate inside publication.

## Authorization and proposed-owner validation ordering (VAY-1928)

`PricingStorageGuard.lock(client, scope)` now rechecks current access and locks
current source revisions without inspecting a proposed snapshot. It runs for all
operations, including historical publication retries. The separate required
`validate(client, scope, proposed)` checks the selected room/owner/terms references
and holds their owner locks for each new publication and every draft save.
There is no default allow for either operation.

Publication checks an existing request receipt after authorization and before
proposed-owner validation. Exact retries return the historical result even when
the accepted proposal's terms or other owner evidence have since changed. Changed
reuse of that request ID still conflicts; revoked access still denies the retry.
For a new request, exact draft binding and current source/base checks precede owner
validation, followed by the existing currency-conversion checks and atomic writes.
This supersedes the earlier combined `lock(client, scope, proposed)` interface.
Concrete live owner integration and route wiring remain required; fixture guards
establish ordering coverage only.

## Live room, terms and payment owner composition (VAY-1929)

`lockReplacementPricingOfferOwners` runs inside the caller's database transaction
with trusted RequestContext and a complete proposed snapshot. It rechecks live
manage authorization, active PMS room ownership and the exact current Booking
terms of every offer, then invokes Finance readiness with those verified terms,
the proposed currency/revision and exact `ownerReferences.finance` evidence ID.
Malformed or mixed-scope/revision snapshots fail. Existing owner locks remain held
until the caller commits or rolls back; provider capability rules are not copied.

The result reports verified terms/Finance evidence or a specific unavailable
component, including Finance's reason. It does not validate other owner references,
complete source revisions, mandatory-charge declarations, FX or separately owned
amount conversion. It must be composed with those checks for publication; a
`verified` result here alone never authorizes publication or checkout. No route or
active pricing mutation is exposed by this owner-composition port.

## Charge declaration in the combined owner check (VAY-1930)

`lockReplacementPricingOfferOwners` now also requires source revisions from the
caller's current, transaction-locked owner reads and an explicit
`ownerReferences.charges` declaration. After live access, PMS, Booking and Finance
verification, it calls the charge owner with the same complete proposal and source
snapshot. The verified result includes the declaration; missing, foreign or changed
evidence returns `charges_stale`. There is no implicit confirmation or zero-charge
fallback. Inputs used for declaration binding are copied before asynchronous owner
reads so this operation checks one proposal.

Attaching the declaration's own reference remains valid. Price, child/meal or
non-self source changes require a new declaration. This supersedes VAY-1929's
exclusion of charge verification, but does not establish the provenance/freshness
of supplied source tokens: the complete source guard must still collect and lock
them. FX and separately owned conversion, command wiring and routes remain separate
obligations before publication is available.
