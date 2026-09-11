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
