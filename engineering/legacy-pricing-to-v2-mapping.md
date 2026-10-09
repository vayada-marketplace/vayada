# Legacy pricing to pricing-v2 publication for migrated hotels (VAY-2086)

_Design, phase 1, 2026-10-09. Docs only: nothing here is implemented, merged,
deployed or approved for go-day. Files cited as "(stack)" exist only on the
unmerged `fm/vay-1362-cohort-*` branches, not on `main`._

## Decision and scope

Flamur, 2026-10-09: on go-day, after the cohort import and **before reopen**,
each migrated cohort hotel's legacy prices are converted to pricing-v2 and
**published**, so the hotel keeps selling; owners adjust later.

Without this step, a cohort hotel has no `pricing_v2` head and no
`pms-pricing.v1` plan (the imported `LEGACY-FLEX`/`LEGACY-NRF` plans keep a NULL
contract version). The VAY-2066 auto-open job then marks every room
`missing_rate` with a sellable count of 0
([auto-open contract](pms-calendar-auto-open-contract.md)).

Rules this design follows:

- **Command path only.** Publication goes through
  `createReplacementPricingCommands(pool, context)`
  (`apps/api/src/domains/replacementPricingCommands.ts`). This is the same
  chain as `PricingEditor.save()` and VAY-1943's `publishFirstPricing`: stage
  terms → prepare → save draft → review charges → confirm charges → save draft
  with the declaration → publish. There are no raw inserts into
  `pms.pricing_v2_*` or `booking.pricing_v2_*`.
- **Payment terms copy each hotel's current legacy setting** (Flamur, via the
  VAY-965 coordinator). There is no single global rule:
  - pay at property stays pay at property;
  - online card payment stays online;
  - a deposit or prepayment rule carries over as closely as v2 allows.

  Anything v2 cannot represent exactly gets the nearest **safe** equivalent
  listed below. The dry run flags it per hotel for review before go-day.

- **Go-day gate per hotel:**
  - legacy and new quote parity on sample stays, within the rounding rules
    below;
  - for online payment, Finance and Stripe readiness for that hotel's
    currency.

**Ownership.** The pricing stream (the VAY-1543/2079 worker) owns the mapping
and the converter. VAY-1362 owns the go-day integration and the gate. Releases
go through the VAY-965 coordinator.

## Cohort and currency facts

The initial cohort is 8 hotels. The manifest of record stays outside the repo
(runbook).

| Currency | Hotels (legacy hotel ID prefix)                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| USD      | Aether A `26e9e98f`, Aether B `29f39aae`, Animals `6aca326e`                                                           |
| IDR      | Haigha House `e41d252d` (3 room types), Dolcemare `7d3f6dcc`, Tiga `8f5919ed`, Nirvana `b8efb175`, Miliways `c8efd685` |

Haigha House replaces `6810de91` (USD), which is now outside the cohort.

A read-only production count over the 8 candidates plus the 24 expansion
hotels (taken before that swap) found:

- **Currencies.** 25 hotels price in IDR and 7 in USD; none in EUR.
- **One currency per hotel.** Each hotel has exactly one room-type currency,
  and it equals `booking_hotels.currency`.
- **IDs.** `booking_hotels.id` equals the PMS `hotels.id`.

The converter still asserts both facts per hotel and blocks when either fails.

- **Minor units.** IDR and USD are both scale 2: IDR minor = rupiah × 100 and
  USD minor = cents (`replacementPricing.ts`, ISO accounting scales). Legacy
  charged Stripe `ceil(amount × 100)` in every currency, IDR included
  (`booking_service.py:710`), so v2 minor amounts use the same convention.
  Legacy prices can contain fractional rupiah (`round(x, 2)` after a
  percentage), and the converter keeps them exactly.
- **Whole rupiah is a separate decision.** VAY-2085 item 2 decides whole-rupiah
  prices separately. It must not change stored amounts before go-day,
  otherwise the parity tolerance below no longer holds.
- **One currency everywhere.** These must all equal the pricing currency, and
  any mismatch **blocks**:
  - `finance.payment_settings.default_currency` (the import copies the
    legacy booking currency);
  - `pms.property_pricing_settings.currency`;
  - every room currency.

  The pricing currency **cannot change after the first publication** (the
  storage guard's `allowCurrencyChange` is `false`), so every check runs
  before publishing.

- **IDR prerequisite (VAY-2085, #3023).** This PR adds IDR to the apps/api PMS
  pricing currencies and to the hotel-setup `FIRST_CURRENCIES`. The import
  writes `property_pricing_settings` itself, but only for its own copy of that
  list (`NATIVE_PRICING_CURRENCIES` in `productionPmsCohortSetup.ts`, stack),
  which has no IDR today. That copy must gain IDR in step with #3023.
  Otherwise the 5 IDR cohort hotels get no pricing-settings row. They then stay
  `provisioning`, cannot pass readiness criterion f, and are invisible to the
  public quote that G2 uses.
- **Card eligibility in Finance.** Finance treats every currency except BHD,
  JOD, KWD, OMR and TND as card-eligible (`0119`), so IDR and USD pass that
  rule. Stripe's handling of IDR on a connected account is a separate fact.
  The card-acceptance Stripe test-mode run (K5) must prove it with one IDR and
  one USD account.

## Legacy model: what guests saw

Source: `apps/pms-api` (Python). Prices are per room per night in **major
units** of the room's currency (`NUMERIC(15,2)` columns and JSONB numbers or
strings). They are computed live with `float` and `round(x, 2)`.

| Legacy input (`pms.room_types` unless noted)                                                                | Meaning in the direct booking engine                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base_rate`                                                                                                 | Night price when no season matches. If it is 0, legacy uses the lowest positive season `rate` instead, counting every season, even one with a missing bound.                                                                                                       |
| `seasons[]` `{name, tier, from, to, rate, minStay, maxStay, occupancyRates}`                                | Yearly ranges (`2024-MM-DD` or `MM-DD`) that may wrap New Year. The first season in array order that covers the night and has a truthy `rate` wins. `occupancyRates["<adults>"]` replaces its `rate`.                                                              |
| `daily_rates{"YYYY-MM-DD": amount}`                                                                         | Final price for that night, with no weekend surcharge and no occupancy pricing.                                                                                                                                                                                    |
| `weekend_surcharge` (`"+15%"`)                                                                              | Percent added on Friday and Saturday nights (Python `weekday()` 4 and 5), on top of the season, occupancy or base price. Negative or unparseable values count as 0.                                                                                                |
| `flexible_rate_enabled`, `non_refundable_enabled`                                                           | Which of the two rate options the room offers.                                                                                                                                                                                                                     |
| `non_refundable_discount` (int %), `non_refundable_rate`                                                    | NR night = flexible night × (1 − d%) when d > 0. Otherwise the static `non_refundable_rate` when > 0, otherwise the flexible night. With flexible disabled, NR = flexible with no discount.                                                                        |
| `monthly_rates`                                                                                             | **Dead.** Removed from the price lookup in `42a678b84`.                                                                                                                                                                                                            |
| `hotels.last_minute_discount`, `room_types.last_minute_discount`                                            | Tiered `int(pct)` discount on the room total, by days before arrival (property-local today). The hotel switch is the master. A non-empty room tier list replaces the hotel's, and a room can opt out. Tiers at 0% or below are skipped.                            |
| season `minStay` / `maxStay`                                                                                | Enforced for direct bookings: minimum stay is read at arrival; maximum is the tightest across the stay.                                                                                                                                                            |
| room `min_stay`, `max_stay`, `closed_to_arrival`, `closed_to_departure`                                     | **Channex only** (room-wide defaults behind the season values). Not enforced for direct bookings.                                                                                                                                                                  |
| `minimum_advance_days`                                                                                      | Rejects check-in sooner than N days away.                                                                                                                                                                                                                          |
| `cancellation_policies` (hotel; default 7 free days), room `flexible_cancellation_type`, `partial_refund_*` | Server refund rules (see the mapping below). The room's `cancellation_policy` text was only displayed.                                                                                                                                                             |
| `rate_payment_methods{flexible,nonrefundable}`, `hotel_payment_settings`, booking-engine flags              | **Server-enforced** (`booking_service.py:450-460`): a method must be in the rate's list (when set) **and** enabled for the hotel. Methods are `card` (Stripe Connect or the `vayada` platform account), `xendit`, `pay_at_property`, `bank_transfer` and `paypal`. |
| `rate_deposit_settings{option}` `{enabled, percentage}`                                                     | Deposit = round(total × p%, 2), charged online at booking; the balance is paid at the property. Pay at property is refused for that rate. On a paid cancellation, legacy keeps `max(deposit, penalty)`.                                                            |
| `instant_book` (booking engine)                                                                             | Request mode keeps card bookings as manual capture (deposits are captured immediately).                                                                                                                                                                            |
| `meal_plans[]`, `channex_channel_markups`                                                                   | **OTA only.** A meal surcharge and channel markup applied on the Channex push.                                                                                                                                                                                     |
| `max_occupancy`, `max_adults`, `max_children`                                                               | Capacity only; children never change the price.                                                                                                                                                                                                                    |

Legacy pricing has no taxes, fees or extra-guest charges. Add-ons and promo
codes are Booking-owned and outside this ticket.

**Authoritative legacy quote.** Both `POST /{slug}/bookings/quote` and booking
creation run:

1. **Rules.** `_prepare_booking_context` (`booking_service.py:380-459`) checks
   season minimum and maximum stay, sellability, minimum advance days, guest
   mix, and the method rules above.
2. **Price.** `_compute_booking_pricing` computes:
   - per night, `resolve_rate` (`room_type_repo.py:368`), then the NR rule,
     each step rounded with `round(…, 2)`;
   - `room_total = round(round(Σ nights, 2) × rooms, 2)`;
   - last-minute as `round(room_total × int(pct)/100, 2)`, subtracted once;
   - add-ons and promo codes, which are outside the samples.

The legacy room listing applied last-minute per night. The quote is what
bookings charged, so the gate compares against the quote.

## Pricing-v2 target

There is one `PricingConfiguration` (`version "pricing.v2"`) per room type. They
are published as a whole-property snapshot `{currency, rooms[],
ownerReferences:{finance, charges}}`
(`packages/domain-pms/src/replacementPricingConfiguration.ts`).

- **Amounts and modes.**
  - Amounts are integer minor-unit strings; calendar prices must be positive.
  - Each offer has one price mode across base, months and seasons. Date
    overrides may flatten it.
- **Price per night.**
  - Precedence is date override > season > month > base, then the weekday
    adjustment (ISO Monday = 0). A date override skips that offer's own
    adjustments.
  - A linked offer applies its fixed or basis-point adjustment to its parent's
    room component, including the parent's date override. Every step rounds
    half-up.
- **Seasons and restrictions.**
  - Price seasons and restriction seasons are separate lists. Both are
    recurring `MM-DD` ranges compared as strings, may wrap New Year, and must
    not overlap.
  - Restrictions consist of own base rules, seasons and exact dates. Minimum
    stay and CTA are read at arrival, CTD at departure, and maximum stay and
    stop-sell on every night. A rule must have `max ≥ min`.
- **Booking terms per offer.**
  - Cancellation is `non_refundable`, or `flexible` with
    `free_until_days_before_arrival` and a required
    `freeCancellationDeadlineDays`. The partial-refund type also requires
    tiers. No v2 refund execution reads the tiers today; they are display
    only.
  - Payment is `full` or `deposit`, with `acceptedMethods` ⊆
    `{card, pay_at_property}`.
- **Finance readiness.** `lockFinanceReplacementPricingReadiness` refuses:
  - any `deposit` term;
  - a currency different from `default_currency`;
  - a property with no executable method.

  It does **not** compare each offer's `acceptedMethods` with the methods it
  finds ready. Public payment then needs both the Finance method and the
  offer's own list (`publicPricingPaymentAmounts.ts`).

- **Card.** It is executable only with a property-scoped, fully onboarded
  Stripe account: details submitted, `card_payments` active, eligible for the
  currency, and carrying unrevoked execution evidence. Acceptance is also
  behind `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED` (default `false`) and
  covers instant booking only ([card acceptance](pricing-card-acceptance.md)).
- **Freshness.** A publication serves public quotes only while the PMS room,
  Booking terms and Finance source tokens it recorded are unchanged
  (`currentPricingPublication.ts`). Any later write to Finance settings, the
  Stripe account row, execution evidence or room facts makes those quotes
  unavailable until a republish.
- **Last-minute** is Booking-owned: `booking_settings.last_minute_discount`
  plus room heads. The public quote applies it. The import leaves it at the
  default `{enabled:false}`. An enabled hotel with no tiers makes every quote
  unavailable.

## Field mapping

Fidelity is one of four values:

- **exact**;
- **safe**: the nearest safe equivalent, recorded as a `review` finding;
- **drop**: not carried, with the reason;
- **block**: the hotel cannot publish until the source is fixed or a decision
  is recorded.

### Rooms, offers and price calendar

| Legacy                                                                            | pricing-v2                                                                                                                                                                                                                                        | Fidelity                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Active room type with a bookable rate option                                      | One configuration; `roomTypeId` = the legacy ID (the import preserves IDs); capacity from the imported room facts                                                                                                                                 | exact                                                       |
| Room with no bookable option, or no positive price                                | Omitted; it stays unpriced, as in legacy                                                                                                                                                                                                          | exact                                                       |
| Amount `x` (major units)                                                          | `Decimal(str(x)) × 100` must be an integer                                                                                                                                                                                                        | exact; otherwise **block** (no silent rounding)             |
| Children never priced                                                             | `adultFromAge: 18`, one band 0–17 with `nightlyMinor "0"`, counted toward capacity                                                                                                                                                                | exact for price (Q9)                                        |
| Flexible option                                                                   | Offer `legacy-flexible`: independent, meal `room_only` with a `"0"` charge                                                                                                                                                                        | exact                                                       |
| NR via discount d                                                                 | `legacy-non-refundable` linked to flexible at −d×100 basis points, restrictions `inherit`. Matches legacy on weekend and override nights.                                                                                                         | exact within rounding; **block** if d ≥ 100                 |
| NR via static `non_refundable_rate`                                               | Independent offer with a flat base and no seasons or weekdays; own copy of flexible's restrictions                                                                                                                                                | exact                                                       |
| NR only (flexible disabled)                                                       | One independent offer with the full calendar, without a discount                                                                                                                                                                                  | exact                                                       |
| `base_rate > 0`                                                                   | `calendar.base`                                                                                                                                                                                                                                   | exact                                                       |
| `base_rate = 0` with seasons                                                      | `calendar.base` = the lowest positive `rate` over **all** seasons, including those missing a bound                                                                                                                                                | exact                                                       |
| Season with a positive `rate` and both bounds                                     | `calendar.seasons[]` with `{name, tier, from, through}`                                                                                                                                                                                           | exact                                                       |
| Season without a `rate` or without a bound                                        | No price season; its stay rules still map (restriction seasons are a separate list)                                                                                                                                                               | exact                                                       |
| `occupancyRates` on any season                                                    | The offer becomes `occupancy` mode with arrays for 1..adults. A missing key takes the season `rate`. A key set to `""` takes the **base** price, because legacy's `float("")` falls through. Other seasons and the base repeat their flat amount. | exact for single-room stays; **block** on a 0 value         |
| Overlapping seasons, including New-Year-wrap overlaps the legacy validator missed | n/a: v2 rejects overlaps                                                                                                                                                                                                                          | **block**: fix in legacy before freeze                      |
| Season bound on `02-29`                                                           | n/a: legacy matches nothing in non-leap years; v2 would match                                                                                                                                                                                     | **block**: move the bound before freeze                     |
| Future `daily_rates` with value > 0                                               | `calendar.dates[]` with a flat price                                                                                                                                                                                                              | exact                                                       |
| `daily_rates` with value ≤ 0                                                      | Restriction date with `stopSell: true`                                                                                                                                                                                                            | exact (unsellable on both sides)                            |
| Past `daily_rates`                                                                | Dropped                                                                                                                                                                                                                                           | drop                                                        |
| `weekend_surcharge` of +p%, p > 0                                                 | `weekdays` days 4 and 5 with p×100 basis points                                                                                                                                                                                                   | exact within rounding; **block** if p×100 is not an integer |
| `weekend_surcharge` ≤ 0 or unparseable                                            | No weekday rows                                                                                                                                                                                                                                   | exact (legacy ignored it)                                   |
| `monthly_rates`                                                                   | Not mapped                                                                                                                                                                                                                                        | drop: dead in legacy, and mapping it would change prices    |
| `meal_plans`, `channex_channel_markups`                                           | Not mapped                                                                                                                                                                                                                                        | drop for direct booking (U9)                                |

### Stay rules

Flexible owns the rules. NR inherits them, or copies them when it is
independent.

| Legacy                                      | pricing-v2                                                                       | Fidelity                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Season `minStay` / `maxStay`                | `restrictions.seasons[]`                                                         | exact                                                                                         |
| Room `min_stay` / `max_stay` (Channex only) | Base rules, and the fallback for seasons that have no value (Channex precedence) | **safe** U5: now enforced for direct bookings too; **block** if a combined rule has max < min |
| Room CTA / CTD (Channex only)               | Base rules                                                                       | **block** if true: it would close direct sales (U5)                                           |
| `minimum_advance_days > 0`                  | None                                                                             | **safe** U6                                                                                   |
| Operating periods                           | Not pricing: the cohort operating-calendar import owns them                      | n/a                                                                                           |

### Booking terms: cancellation

| Legacy (enforced server rule)                                                                           | v2 terms                                                                                          | Fidelity                                                                  |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| NR option                                                                                               | `{kind:"non_refundable"}`                                                                         | exact                                                                     |
| Flexible: hotel `free_cancellation_days` d (7 when no row), no partial refund                           | `flexible` with `freeCancellationDeadlineDays: d`                                                 | exact                                                                     |
| Flexible: hotel partial refund p > 0 after the deadline                                                 | `partial_refund` with tiers `[{d,100},{0,p}]`                                                     | **block** pending Q7 (tiers are display only in v2; no-show differs, U11) |
| Room `partial_refund` with tiers                                                                        | The same tiers                                                                                    | **block** pending Q7                                                      |
| Room `partial_refund` without tiers: `percent or 50` when ≥ `window or 30` days out, else 0, never 100% | Tiers `[{window, pct}]`. v2 rejects the type without tiers and still needs a full-refund deadline | **block** pending Q7                                                      |
| Displayed `cancellation_policy` text                                                                    | Not copied; the enforced numbers win                                                              | **safe**: flagged when its "N days" differs                               |

### Booking terms: payment (copy each hotel's current setting)

The effective legacy methods per rate option are the rate's list (or the
hotel's methods when the list is null), intersected with the hotel-enabled
methods. Pay at property is removed when the rate takes a deposit. v2 payment
is always `{kind:"full", acceptedMethods}`.

| Legacy effective method or rule             | v2                                                              | Fidelity                                                                       |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pay_at_property`                           | `pay_at_property`                                               | exact                                                                          |
| `card` on a property Stripe Connect account | `card`                                                          | exact if G3 holds; otherwise NO-GO (never downgraded)                          |
| `card` on the `vayada` platform account     | `card` only once a property Stripe account is ready             | **block** (U2)                                                                 |
| `xendit`                                    | `card`, when a property Stripe account is ready in the currency | **safe** (U3), otherwise **block**                                             |
| `bank_transfer`, `paypal`                   | Dropped                                                         | **safe** if another method remains; **block** if none (U4)                     |
| No effective method (for example `[]`)      | Offer omitted, because legacy could not book it                 | exact                                                                          |
| Deposit of p% (including 100%)              | `full` with `[card]`: the guest prepays 100% online             | **safe** (U1); the paid-cancellation `max(deposit, penalty)` retention is lost |
| Card while `instant_book = false`           | v2 card acceptance is instant-only                              | **block** (U12)                                                                |

### Last-minute (Booking-owned)

- **Percent.** Each tier gets `int(pct)` (the legacy truncation); a negative
  value becomes 0.
- **Zero tiers are kept.** v2 accepts 0%. A room whose tier list is all 0%
  still replaces the hotel's tiers.
- **Hotel switch off.** `{enabled:false, …}` becomes `{enabled:false,
stackWithPromo:false, tiers:[]}`.
- **Hotel enabled with no tiers.** Add a 0% catch-all tier `{0, null, 0}`.
  This behaves the same as legacy and keeps v2 from refusing every quote.
- **Rooms.** A room that opted out gets a head `{enabled:false}`. A room with
  no tiers gets no head (it inherits).
- **Overlapping tiers block.** v2 rejects them, and legacy's first-match order
  cannot be kept.

The hotel-level writer is currently a repository call inside a route, so it
cannot take an operator context. Phase 2 needs a small Booking command, or the
VAY-1362 import carries it (Q3).

## Unrepresentable and lossy (dry-run finding codes)

- `review`: publish only with an approved plan digest that lists the finding.
- `block`: no publication.

| Code | Legacy behavior                                                                                                                                   | Nearest safe v2 equivalent                                                                                                                                                                           | Severity                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| U1   | Deposit p% online, balance at property; a paid cancellation keeps `max(deposit, penalty)`                                                         | Full card prepayment. Same total price, and the hotel never collects less upfront. Pay at property would drop the guarantee, so it is not the default. The retention minimum is lost.                | review (Q1)                                          |
| U2   | Card through the `vayada` platform account                                                                                                        | None until the hotel has a ready property Stripe account                                                                                                                                             | block                                                |
| U3   | Xendit online                                                                                                                                     | Stripe card, if it is ready in the currency                                                                                                                                                          | review, else block                                   |
| U4   | Bank transfer, PayPal (manual)                                                                                                                    | Dropped when another method remains                                                                                                                                                                  | review, or block if sole                             |
| U5   | Room-level min/max stay, CTA and CTD on OTAs only                                                                                                 | Applied to both channels, so direct booking gets stricter. CTA or CTD true, or a combined max < min, blocks.                                                                                         | review / block                                       |
| U6   | `minimum_advance_days` rejects near-term arrivals                                                                                                 | None: v2 has no rolling lead-time rule (same-day cutoff covers N ≤ 1)                                                                                                                                | review                                               |
| U7   | Multi-room bookings look up occupancy by the party's **total** adults                                                                             | v2 prices each room by its own guests; samples are single-room                                                                                                                                       | info                                                 |
| U8   | Float `round(x, 2)` per step                                                                                                                      | Integer half-up per step, within the tolerance below                                                                                                                                                 | info                                                 |
| U9   | OTA meal-plan rate plans and per-channel markups on the Channex push                                                                              | None in this step. A meal offer would also appear in direct booking, and Channex must bind rates explicitly ([offer targets](channex-published-offer-targets.md)). Hand off to the Channex handover. | review (any hotel with meal mappings **or** markups) |
| U10  | Source defects: `02-29` bounds, overlapping seasons, occupancy price 0, non-integer basis points, sub-cent amounts, overlapping last-minute tiers | None. Fix in legacy before freeze                                                                                                                                                                    | block                                                |
| U11  | Partial refunds (hotel after the deadline; room window or tiers), which also apply to a no-show                                                   | v2 tiers are display only, and the no-show penalty is the full amount                                                                                                                                | block pending Q7                                     |
| U12  | Card bookings in request mode                                                                                                                     | None until request-mode card acceptance exists                                                                                                                                                       | block (or the hotel switches to instant)             |

Promo codes, add-ons, OTA inbound pricing and existing bookings' frozen price
evidence are untouched.

## Execution design

### Source rows: attested migration source, not the imported projection

The converter reads the cutover source run's attested rows:

- `migration_source_pms.snapshot_rows`: `room_types`, `hotels`,
  `cancellation_policies` and `hotel_payment_settings`;
- `migration_source_booking.snapshot_rows`: `booking_hotels` and the payment
  flags.

It re-verifies each row's checksum the way `productionPmsSnapshotReader` does.
Why not the imported target rows:

- **Same source on both sides.** The attested rows are the freeze-proofed copy
  of what legacy served, and they are what the parity reference reads.
- **The import is lossy.** The imported rows store `daily_rate` as a delta,
  drop seasons that lack a bound, ignore `flexible_rate_enabled` for NR, and
  keep `occupancyRates` only in raw form.
- **The import is mutable.** Those runtime tables can change after reopen.

A drift check compares the fields the imported `room_attributes.legacyPricing`
snapshot carries; a mismatch blocks. That snapshot omits base, NR and currency,
so those come only from the source rows. Hotels join on
`booking_hotels.id = hotels.id`; target IDs come from the IDs the import
preserves and from `propertyForHotel`.

### CLI

The tool lives in `apps/api/src/cli/`, because it needs the apps/api commands.
It follows the pattern of `financeOtaCommissionPreactivation.ts`: one hotel per
run, `TARGET_DATABASE_URL`, and a dry run by default.

```bash
npm --workspace vayada-api run pms:legacy-pricing:publish -- \
  --source-run <sourceRunId> --property-id <uuid> --operator-user-id <uuid> \
  [--apply-for-property <uuid> --approved-plan-sha256 <sha>]
npm --workspace vayada-api run pms:legacy-pricing:parity -- \
  --source-run <sourceRunId> --property-id <uuid>
```

- **Dry run** writes nothing and prints `legacy-pricing-plan.v1`. The plan
  contains the proposed snapshot, the terms per offer, last-minute, the
  findings, the samples and `planSha256`.
  - Finance readiness comes from calling
    `lockFinanceReplacementPricingReadiness` with the plan's terms inside a
    transaction that is always rolled back. It cannot use `prepare`: without
    a draft, a never-published hotel has no term heads and is `denied`, and
    staging terms would be a write.
  - That result also feeds the per-offer method check (G3).
- **`planSha256` is stable across days.** It covers only date-independent
  content: the normalized legacy pricing fields (not whole rows or
  `updated_at`), the converter version, the mapped output with every daily
  override, and the findings. The go-day filtering of past dates and the
  dated samples are outside the digest. That keeps a T-2 approval valid on
  go-day unless prices really changed.
- **Apply** needs:
  - `--apply-for-property` equal to `--property-id`;
  - the reviewed digest;
  - no `block` findings.

  It runs the command chain and verifies that the head equals the plan.

- **The pure converter** lives in `packages/domain-pms` with fixtures, owned
  by the pricing stream.

### Operator actor (blocking decision D1) and the declaration

The commands need a trusted `RequestContext`, and access is rechecked live
(`replacementPricingAuthorization.ts`). That check needs:

- an active `identity.users` row;
- an active `agency` membership in the hotel's `hotel_group` organization,
  with a role granting `pms.rooms_rates.manage`, plus an assignment row when
  the membership is `assigned`;
- an owner or operator property link;
- the PMS entitlement.

There is no legitimate way for a CLI to build that context today:

- **WorkOS only.** `resolveRequestContext` works only from a WorkOS session
  (`packages/backend-auth/src/resolve.ts`).
- **No serialized context.** The [command-service contract](pricing-command-service-contract.md)
  forbids a serialized `RequestContext` and any identity that does not come
  from WorkOS.
- **`identity.access.grant` cannot set this up.** It writes no assignment row.
  It overwrites the organization's name, slug, status and kind. Passing
  `permissionKeys` inserts global grants that `revoke` never removes. If the
  user is already a member, it overwrites that membership.

The decision, needed before phase 2:

- **D1-a (proposed): a reviewed migration context.**
  - A narrow builder in apps/api reads the operator's **real**
    staff membership from the database the same way the database stage of
    `resolveRequestContext` does, and sets `audit.source = "migration"`.
  - The VAY-1362 identity import writes that membership per cohort property,
    as a migration action. It uses a dedicated `migration_operator` role
    preset (rooms/rates read and manage, plus last-minute manage) and its
    assignment row, with no `permissionKeys`, and does not touch organization
    fields.
  - The builder refuses any property outside the run's bound cohort, and an
    aborted run.
  - Reopen is a runbook step, not a flag, so the builder cannot check it. The
    window ends instead when the tool removes the membership with
    `identity.staff.remove` after the final gate.
  - Why this adds no privilege: the CLI principal already holds target
    write credentials, so the builder only adds attribution. It still needs
    a security sign-off.
- **D1-b: the operator's real WorkOS session against the HTTP API.** This does
  not fit the window:
  - cohort organizations only exist after M;
  - invitations need email acceptance;
  - F.3 keeps the PMS write routes in maintenance.
- **Rejected:**
  - acting as the legacy owner (it is not their declaration, and the context
    problem is the same);
  - a bypass in the authorization helper.

The operator recorded as actor is a named Vayada ops user. It appears on
revisions, drafts, terms and the charge declaration.

**Declaration.** `confirmCharges` gets `declaredVia: "legacy_import"`. Today
`declaredVia` is a TypeScript literal, `"save_prices"`, checked in
`replacementChargeDeclarations.ts` and in the route. There is **no DB CHECK or
enum**: the value is stored in `product_audit_events.audit_metadata` (JSONB).
The minimal extension:

- **Union.** Widen it to `"save_prices" | "legacy_import"`.
- **Reference.** `legacy_import` requires `legacyImport: {sourceRunId,
planSha256}`.
- **Audit note.** It stores a fixed server-side note:
  _"Declared by Vayada operations on the hotel's behalf during the VAY-1362
  migration: these are the prices guests already saw in legacy, which showed
  no separate mandatory charges."_
- **HTTP route.** It keeps accepting only `"save_prices"`.

### Idempotency and re-runs

- **Deterministic IDs.**
  - The draft ID and the request IDs derive from `vay2086:`, `planSha256`,
    the property, the base revision and the operator.
  - Request hashes include the actor, so a retry by another operator gets
    fresh IDs instead of `idempotency_conflict`.
  - Lost responses replay through the existing receipts and the draft CAS.
    Resuming reads the draft, as `publishFirstPricing` does.
- **What a run does, by head state:**
  - **Head 0:** run the full chain.
  - **Head is this tool's, same plan, publication current:** no-op.
  - **Head is this tool's, but stale or a different plan** (for example a
    Finance write after publishing, or R1 then a retried go-day): publish a
    new revision. This is allowed only while every revision is the tool's
    own (`vay2086:` request IDs).
  - **Head published by anyone else:** refuse with `published_elsewhere`.
    The tool never overwrites owner prices.
  - **`stale` mid-chain:** abort this hotel. A re-run starts a new draft with
    an attempt suffix.

### Go-day placement

These steps go into the go-day runbook
(`engineering/legacy-migration-go-day-runbook.md`, stack).

**Prerequisites:**

- VAY-2085 (#3023) is deployed, and the import's currency copy includes IDR.
- D1 is implemented.
- For any hotel keeping online card payment: card acceptance K1–K5 and the
  flag, plus the Stripe test-mode run with an IDR and a USD account.
- **T-2:** run the dry run on the `target:cutover:dry-run` target, approve
  each digest, and fix `block` sources in legacy before the freeze.

**On the day:**

1. **S.0 as today, with one change.** Card hotels must publish their
   bookability profile through the normal profile publish, not
   `target:booking-public-bookability:backfill`. On conflict, the backfill
   resets `accepted_methods` to pay at property (stack).
2. **S.0a, card hotels.**
   - Refresh the migrated Stripe account and record online-card execution
     evidence through Finance's existing readiness path. The import writes
     neither, so card readiness cannot hold without this step.
   - It comes before publishing, because publishing binds the Finance
     source.
3. **S.0b, publish.** Dry run, compare digests, apply, then G1–G4.
   - It runs after `AWAITING_SMOKE`. Resume-from-smoke only validates the
     smoke report, so parity evidence is unaffected.
   - The F.3 pause holds: the tool uses commands over a direct pool, after
     the imports.
   - The next auto-open run re-plans the hotels whose rooms gained offers.
4. **S.1–S.4.** The smoke covers the published rates on the public page.
5. **After H.2–H.4, before H.5.** Re-run the gate. Stripe `account.updated`
   events after the endpoint moves, or any Finance write, can make the
   publication stale; the tool then republishes its own plan. H.5's first ARI
   push reads the published offers. ARI is not mutating before then, so the
   `pricing.v2.revised` outbox causes no provider writes.
6. **Immediately before O.1.** Final gate run. Only GO hotels reopen.

## Go-day gate (per hotel)

`pms:legacy-pricing:parity` is read-only. Any transaction it opens is always
rolled back. It returns GO, NO-GO or REVIEW, and exits 0, 2 or 3 like
`target:parity`.

**G1. Publication is current and equals the plan.**

- The head is the tool's revision, and its rooms and terms equal the approved
  plan.
- The current-publication reader returns it, meaning all three source tokens
  are still current.

**G2. Quote parity.**

**Samples**, generated deterministically:

- every room × offer;
- every priced season, on a weekday and on a Friday or Saturday;
- base-gap nights and up to 20 overrides;
- stays crossing a season, a weekend and the New Year;
- 1, 3 and 7 nights;
- adults 1..capacity for occupancy rooms, plus one stay with a child;
- last-minute arrivals at each tier's minimum and maximum day;
- one date about 11 months out.

All samples are single-room, inside the open window, and use no add-ons or
promo codes.

**Legacy side: the real legacy Python.** A read-only `apps/pms-api` script runs
the rule checks of `_prepare_booking_context` (stay rules, sellability, minimum
advance days, guest mix; inventory counts excluded) and the
`_compute_booking_pricing` arithmetic. It runs on the exported source rows, at
the gate's property-local date, and returns `priced` or `rejected(reason)`.

- A TypeScript port would share the converter's assumptions.
- A pre-freeze API capture would miss later edits.

**New side.** The public quote's amount composition (room components with
last-minute, then charges), in an always-rolled-back transaction, so no quote
record is written. It cannot be `READ ONLY` because the owner readers take row
locks. Nightly lines from `calculateReplacementRoomStay` localize any
mismatch.

**Expected divergences.** A sample counts as one only when the hotel's approved
digest lists the finding:

- U5: legacy priced, v2 rejects for a room-level restriction;
- U6: legacy rejects for minimum advance, v2 prices.

**Rounding.** Legacy amounts convert exactly (`Decimal(str(x)) × 100`). Let k
be the number of percentage steps legacy applied to a night: weekend
surcharge and NR discount, so 0–2.

- **Per night:** |Δ| ≤ k minor units. Fixed-amount nights match exactly.
- **Stay total before last-minute:** |Δ| ≤ Σk.
- **After last-minute:** |Δ| ≤ Σk + 1.

For IDR, one minor unit is 0.01 rupiah; for USD it is one cent. Any larger
difference, or any other priced/rejected disagreement, is **NO-GO**.

**G3. Finance and Stripe readiness, per currency (IDR, USD).**

- **Settings.** `finance.payment_settings` exists with `payments_enabled`.
- **Currency.** `default_currency` equals the pricing currency, the
  `property_pricing_settings` currency, the room currency and
  `booking_hotels.currency`.
- **Methods.** Every published offer's `acceptedMethods` is a subset of the
  methods Finance reports ready. No offer has deposit terms.
- **Card readiness.** Each offer with `card` has Finance online-card readiness
  `ready` for its currency: a property-scoped Stripe account with details
  submitted, charges and payouts enabled, `card_payments` active,
  currency-eligible, and unrevoked execution evidence.
- **Flag.** `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true` on next-api.
  This is a human checkbox; the CLI cannot read that environment.
- **Online stays online.** No legacy online method ended up offline. A hotel
  whose online payment cannot stay online is NO-GO, never silently pay at
  property.

**G4. Findings.** No `block` findings, and every `review` finding is in the
approved digest.

A NO-GO hotel does not reopen. The approver runs R1, or suspends that hotel with
the platform admin lifecycle command and fixes forward (Q10).

## Phase 2 slices (after review)

1. **Pricing stream:** the converter with fixtures for every row and finding,
   and `declaredVia: "legacy_import"`.
2. **D1:** the migration context builder (with a security review) and the
   operator membership in the identity import.
3. **VAY-1362:** the source reader, the plan, and the dry-run CLI, with
   seeded-target tests.
4. **VAY-1362:** apply, the re-run rules, and the last-minute carry-over (a
   Booking command or the import).
5. **VAY-1362:** the Python reference and the gate, with a CI test that pins
   the reference against `quote_booking_request`.
6. **VAY-1362:** runbook steps S.0a, S.0b and the gate re-runs; the rehearsal
   on the isolated restore.

## Open questions

1. **Deposits (U1).** Full card prepayment (proposed), or pay at property per
   hotel?
2. **D1 actor.** Should we use the migration context builder (proposed), and
   who signs off on security?
3. **Last-minute carry-over owner.** A new Booking command used by this tool,
   or the VAY-1362 booking import?
4. **Card go-live.** Will card acceptance (K1–K5 plus the flag) and the S.0a
   Stripe refresh be ready for the 3 USD and 5 IDR hotels? If not, every hotel
   whose legacy payment is online fails G3.
5. **No v2 method (U2–U4, U12).** Which cohort hotels use the `vayada`
   platform card, Xendit, bank transfer, PayPal or request mode? Do they
   switch before go-day, or get a decision per hotel?
6. **U9.** OTA meal plans and channel markups: adopt them as v2 offers, which
   also appear in direct booking, or close them on Channex before H.5?
7. **Partial refunds.** What do `freeCancellationDeadlineDays` and the
   `partial_refund` tiers mean in v2? Today the tiers are display only, and
   that blocks every hotel with partial refunds.
8. **U5 and U6.** Accept stricter direct-booking stay rules, and decide on
   minimum advance days.
9. **Child age.** `adultFromAge` 18 (price-neutral), or the hotel's published
   child policy?
10. **Per-hotel NO-GO.** Run R1 for the whole cohort, or suspend only that
    hotel?
11. **Declaration.** For hotels that collect taxes at the property, is "all
    mandatory charges included" still accurate, or do they need a fixed-charge
    policy after reopen?
12. **Staleness after reopen.** Any Finance or room-facts write silently
    unpublishes pricing until someone republishes. Is that intended, and who
    republishes for migrated hotels?
