# Replacement pricing contract (VAY-1539)

Authority: [agreed rules and owners](https://linear.app/vayadacom/document/agreed-pricing-rules-and-concrete-implementation-ownership-243a6a868936).
This supersedes the older occupancy-only contract. Stack after VAY-1546 deletion;
no runtime fallback, routes, persistence, evaluator or provider activation here.

## Money and room modes (VAY-1554)

All amounts are canonical integer minor-unit strings, never JS floating-point
money. Currency vocabulary/scale comes from the runtime ISO/ICU currency data;
unknown codes fail. Store currency alongside amount. Scale-0 JPY, scale-2 IDR,
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

## Pure room-night evaluation (VAY-1542)

The calculator receives one scoped configuration, allocated guests, stay dates,
expected configuration revision and expected terms revisions for the selected
plan and its ancestors. These expectations come from trusted owner reads; the
pure calculator cannot establish database freshness itself. It returns nightly
room and meal amounts separately with source/adjustment provenance.

A date RoomPrice replaces the adult-equivalent tariff and bypasses that plan's
weekday/link adjustment. Child-band nightly supplements still apply once; they
are a separate explicit policy. Normal weekday and linked adjustments apply to
the whole room component including those supplements, before the selected meal.
A linked final date price resets the room component; clearing it restores the
parent calculation. Parents' meals never propagate to a child plan. Restrictions
are resolved separately, including departure-day CTD. Booking promotions, taxes,
add-ons, FX conversion and payments remain owner orchestration outside this PMS
calculator. No runtime endpoint or provider write is activated by this module.
