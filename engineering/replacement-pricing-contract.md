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
or per-person. Unknown/extra fields fail. Switching modes replaces the entire
price object; inactive fields cannot silently survive as active rules. Occupancy
arrays encode exactly one row for each adult-equivalent count 1..adultCapacity.
Equal amounts at different occupancies are legal; sparse/missing rows are not.
Included-guests adjustments are relative to one base price, including reductions
for fewer guests. The base row is a fixed zero delta. Percentages use integer
basis points (1000 = 10%); round half-up once after each applied adjustment.
A nonpositive effective room amount is unavailable, not a fabricated free rate.

Parsers validate configuration only. Tests are contract-boundary tests, not proof
that the future VAY-1542 evaluator or a connected OTA calculates prices correctly.
