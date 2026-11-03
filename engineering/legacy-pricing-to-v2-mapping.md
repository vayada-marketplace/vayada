# Legacy pricing to pricing-v2 publication for migrated hotels (VAY-2086)

_Design, phase 1, 2026-10-09. Docs only: nothing here is implemented, merged,
deployed or approved for go-day. Files cited as "(stack)" exist only on the
unmerged `fm/vay-1362-cohort-*` branches, not on `main`._

## Decision and scope

Flamur, 2026-10-09: on go-day, after the cohort import and **before reopen**,
each migrated cohort hotel's legacy prices are converted to pricing-v2 and
**published**, so the hotel keeps selling; owners adjust later.

Without this step, a cohort hotel has no published `pricing_v2` revision and
no `pms-pricing.v1` plan (the imported `LEGACY-FLEX`/`LEGACY-NRF` plans keep a
NULL contract version). The VAY-2066 auto-open job then marks every room
`missing_rate` with a sellable count of 0
([auto-open contract](pms-calendar-auto-open-contract.md)).

Rules:

- **Command path only.** Publication goes through
  `createReplacementPricingCommands(pool, context)`
  (`apps/api/src/domains/replacementPricingCommands.ts`). It is the same chain
  as `PricingEditor.save()` and VAY-1943's `publishFirstPricing`: stage terms →
  prepare → save draft → review charges → confirm charges → save draft with the
  declaration → publish. There are no raw inserts.
- **Payment terms copy each hotel's current legacy setting** (Flamur):
  - pay at property stays pay at property;
  - **online card stays online card from go-day** (option A);
  - a deposit or prepayment becomes full card prepayment.

  There is no pay-at-property fallback for an online hotel. A hotel whose card
  readiness fails the gate is suspended instead (the per-hotel suspend steps
  below). Anything v2 cannot represent gets the nearest safe equivalent,
  flagged per hotel by the dry run.

- **Phased waves** (Flamur, 2026-10-10). A hotel moves only once it can take
  v2 bookings as it does today. The card hotels need their own Stripe Connect
  account. Request-mode hotels need VAY-2099 (slice 1 for pay at property,
  slice 2 for card), and hotels with partial-refund tiers need VAY-2100. Wave 1 is Aether B, Dolcemare and Haigha (see "Cohort
  outcome and waves").
- **The gate is per hotel.** It checks quote parity on sample stays within the
  rounding rules, and Finance and Stripe card readiness for the hotel's
  currency.

**Ownership.**

- The pricing stream (the VAY-1543/2079 worker) owns the converter and the
  `declaredVia: "legacy_import"` widening (phase-2 slice 1).
- VAY-1362 owns the go-day integration, the gate, and the runbook. The
  coordinator updates the runbook on the cohort stack.
- Releases go through the VAY-965 coordinator.

**Decided** (Flamur and the coordinator, 2026-10-09):

- deposits become full card prepayment;
- stricter stay rules for direct bookings are accepted;
- children stay free with `adultFromAge` 18 when the hotel has no own policy;
- no cohort hotel collects taxes or fees on arrival, so the charges
  declaration is true;
- a hotel that fails the gate is suspended on its own;
- the operator is Flamur's own platform account (D1);
- Feb-29 seasons follow option (a), mirroring today (U15);
- phased waves, with no platform-account card in v2 (2026-10-10).

## Wave prerequisites (runbook #3042 labels)

The phased-waves runbook owns the full list, P1–P21
(`engineering/legacy-migration-go-day-runbook.md` on
`fm/vay-1362-runbook-phased-waves`, #3042). This design depends on the
following:

| Runbook       | What                                                                                                                                                                                                                                                                                             | Wave-1 hotels                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| P4            | VAY-2086 itself: the converter and `declaredVia: "legacy_import"` (pricing stream), the D1 migration context (independent security review, then Flamur's sign-off), the publish and parity CLIs, and the gate G1–G5                                                                              | all 3                         |
| P7            | VAY-2085 IDR (#3023), plus IDR in the import's `NATIVE_PRICING_CURRENCIES`                                                                                                                                                                                                                       | Dolcemare, Haigha             |
| P8            | VAY-2099 slice 1: pay-at-property request mode, mapped 1:1. Its flag `REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED` (default off) is turned on with Flamur's go at S.0b. Slice 2 (card request mode: authorise, host confirms, then capture or void) is for later waves (W2.3)                 | Dolcemare, Haigha             |
| P9            | VAY-2100. **PR2** fixes the v2 online guest-cancel preview, which answers `409` today; all three wave-1 hotels need it. **PR1–PR3** (the rule, the guest-cancel fix, the wording) are needed for Haigha's partial-refund tiers                                                                   | all 3 (PR2); Haigha (PR1–PR3) |
| P10           | Card: (a) the Finance-token staleness fix VAY-2088 (#3027) plus a republish; (c) the S.0a Stripe refresh; (d) `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true`, only with Flamur's go; (e) per-hotel card readiness in G3. (b) The K5 IDR run is for the later IDR card hotels                 | Aether B                      |
| P12, P16, P17 | The per-property Channex ownership gate, production Channex capability on next-api, and the target booking intake trigger. Any OTA handover needs all three, and none is built yet                                                                                                               | Aether B                      |
| P13           | Native Channex channel-level markup, confirmed on the staging Channex pair                                                                                                                                                                                                                       | Aether B                      |
| F.3           | **Zero legacy pending requests per wave hotel at the freeze** (a counts-only read). A migrated `pending` request would become `pending_payment` with no acceptance mode or deadline. The target's stale-unpaid sweep cancels such bookings because imported rows keep their legacy creation time | all 3                         |

Earlier revisions of this doc used letters: a–e map to P10, f to P7, g and h
to P4, i to P8 and j to P9.

Today the card scope is instant booking only and full prepayment only. There
is no request-mode card, no automatic refund, and no online cancellation of a
paid booking ([card acceptance](pricing-card-acceptance.md)). VAY-2099 slice 1
adds pay-at-property request mode, slice 2 card request mode, and VAY-2100
automatic partial-refund tiers.

## Cohort and currency

The initial cohort is 8 hotels. The manifest of record stays outside the repo.

| Currency | Hotels (legacy hotel ID prefix)                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| USD      | Aether A `26e9e98f`, Aether B `29f39aae`, Animals `6aca326e`                                                           |
| IDR      | Haigha House `e41d252d` (3 room types), Dolcemare `7d3f6dcc`, Tiga `8f5919ed`, Nirvana `b8efb175`, Miliways `c8efd685` |

Haigha House replaces `6810de91` (USD), which is now outside the cohort.

A count over the candidates plus 24 expansion hotels (32 hotels, before the
Haigha swap) found:

- 25 hotels price in IDR, 7 in USD, and none in EUR;
- each hotel has exactly one room-type currency, equal to
  `booking_hotels.currency`;
- `booking_hotels.id` equals the PMS `hotels.id`.

The converter asserts all of these per hotel and blocks on a mismatch.

**Minor units.**

- IDR and USD are both scale 2: IDR minor = rupiah × 100 and USD minor = cents.
- Legacy charged Stripe `ceil(amount × 100)` in every currency
  (`booking_service.py:710`), so the conventions match.
- Fractional rupiah from percentage arithmetic are carried exactly.
  Whole-rupiah rounding (VAY-2085 item 2) must not change stored amounts
  before go-day.

**Currency checks.** Every check blocks before publishing, because the pricing
currency cannot change after the first publication (`allowCurrencyChange` is
`false`). These must all equal the pricing currency:

- `finance.payment_settings.default_currency` (the import copies the legacy
  booking currency);
- `pms.property_pricing_settings.currency`;
- every room currency.

Since #2941, a published plan in a currency other than the property's counts as
a missing plan.

**IDR.** VAY-2085 (#3023) adds IDR to the apps/api PMS pricing currencies and to
the hotel-setup `FIRST_CURRENCIES`. The import writes `property_pricing_settings`
itself, but only for its own copy (`NATIVE_PRICING_CURRENCIES`,
`productionPmsCohortSetup.ts`, stack), and that copy has no IDR yet. Without it,
the 5 IDR hotels get no row, stay `provisioning`, and cannot pass readiness
criterion f.

**Card.** Finance treats every currency except BHD, JOD, KWD, OMR and TND as
card-eligible (`0119`). Stripe's IDR behavior on a connected account is P10 b.

## Cohort outcome and waves (production read, 2026-10-10)

The input is the reviewed counts-only read of legacy PMS and Booking (plan
`34cdea9d`). Blocks 4 and 5, the overlap pre-checks, were not run; the T-2 dry
run checks overlaps exactly.

**The migration is phased** (Flamur, 2026-10-10).

- **Wave 1:** Aether B, Dolcemare and Haigha.
- **Later waves:** the other hotels stay on legacy until each has its **own**
  Stripe Connect account. Those in request mode keep it: they are blocked on
  VAY-2099 slice 2 (card request mode) and do **not** switch to instant. No
  platform-account card goes to v2.
- For a later-wave hotel, U2 and U12 only mean "not in a wave yet".
- The coordinator is rewriting the runbook for per-hotel waves (legacy freeze,
  Channex and Stripe handover per property). The steps in "Go-day placement"
  apply to each wave's hotels.

**Common to all 8 hotels:**

- **Cancellation.** There are no `cancellation_policies` rows, so legacy
  enforces 7 free days and then the full amount. That maps exactly to
  `flexible` with deadline 7.
- **Nothing else to carry.** No deposits, room-level Channex-only stay rules,
  minimum advance days, occupancy prices, sub-cent amounts or zero occupancy
  prices.
- **More than 12 seasons is not a finding.** v2 has no season cap; only
  overlaps matter.
- **Payment-method mix pending.** `rate_payment_methods` is a dict keyed by
  rate option. The per-hotel mix waits on the platform helper's follow-up
  read: null, `{}`, missing keys, empty arrays, and option × method.
  - The first read's `rooms_with_empty_rate_method_list = 0` was a false zero
    (the lax jsonpath could not match), so treat it as unknown.
  - The per-hotel check "an empty option means nothing is bookable" is
    pending that read.
  - The card, `pay_at_property` and `xendit` counts were correct.

**Gate column:** **block** stops publication or reopen; **review** needs an
approved decision in the plan digest; **pass** needs only the listed
prerequisites.

| Hotel (cur.)             | Wave  | Legacy payment and mode                                                                           | Findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Gate                              | What it needs                                                                                                              |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Aether B `29f39aae` USD  | 1     | Card on its own onboarded Stripe account; instant                                                 | U15 Feb-29 seasons on 5/5 rooms (approved (a)). U9 markup: 10% on one channel (native Channex adjustment at H.6.1, G5 at H.6.2)                                                                                                                                                                                                                                                                                                                                                                                                                             | review → pass                     | P10 (a, c, d, e), P9 PR2, F.3. Its OTA handover needs P12, P16 and P17, plus P13 (see the note below the table)            |
| Dolcemare `7d3f6dcc` IDR | 1     | Pay at property only; **request** mode (kept); no Channex handover in wave 1                      | U12: request mode maps 1:1 to v2 pay-at-property request mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **block** until P8                | P8 (VAY-2099 slice 1 and its flag), P9 PR2, P7, F.3                                                                        |
| Haigha `e41d252d` IDR    | 1     | Pay at property only; **request** mode (kept); **direct booking only** (Option N, pending Flamur) | U12 as Dolcemare. U11: the partial-refund room maps 1:1 as `partial_refund` with tiers `[{26,100}]`, deadline 26 (decided for parity). Its 2 other rooms have flexible disabled (non-refundable only, per the read), so their legacy 7-day free default only applies if flexible is re-enabled. U15 Feb-29 on 3/3 rooms (approved (a)). Option N: no Channex handover and no OTA terms push. Its legacy Channex connection sits on the non-cohort record `6810de91` and stays untouched on legacy; the daily count of new legacy bookings there must stay 0 | **block** until P8 and P9 PR1–PR3 | P8, P9 PR1–PR3, P7, F.3                                                                                                    |
| Aether A `26e9e98f` USD  | later | Card on its own onboarded Stripe account; request mode (kept)                                     | U12: blocked on VAY-2099 slice 2. U15 Feb-29 on 5/5 rooms (approved (a)). Base 0 on 2 rooms becomes the lowest season rate (exact). U9 markup 10%                                                                                                                                                                                                                                                                                                                                                                                                           | not in a wave                     | W2.3 (slice 2), P10, P12, P16, P17, P13                                                                                    |
| Animals `6aca326e` USD   | later | Platform card plus pay at property; request mode (kept)                                           | U2 and U12: blocked on VAY-2099 slice 2 plus its own Stripe Connect account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | not in a wave                     | VAY-2099 slice 2 and its own onboarded Stripe Connect account                                                              |
| Tiga `8f5919ed` IDR      | later | Platform card plus pay at property; instant                                                       | U2 (not in a wave). Base 0 on 3 rooms (exact). U9: OTA meal plan on 1 room (closed at its H.5) and markup 10%                                                                                                                                                                                                                                                                                                                                                                                                                                               | not in a wave                     | Its own Stripe Connect account in IDR (W2.3), P10 including b (the K5 IDR run), P7, P12, P16, P17, P13                     |
| Nirvana `b8efb175` IDR   | later | Platform card plus bank transfer, no pay at property; request mode (kept)                         | U2 and U12: blocked on VAY-2099 slice 2 plus its own Stripe Connect account. U4 bank transfer is dropped (review at its wave). Base 0 on 11 rooms (exact). Hotel last-minute is on with no tiers, which becomes the 0% catch-all                                                                                                                                                                                                                                                                                                                            | not in a wave                     | W2.3 (its own Stripe account in IDR and slice 2); without card it has no v2 method. Accept the bank-transfer drop. P7, P10 |
| Miliways `c8efd685` IDR  | later | Platform card plus bank transfer, no pay at property; request mode (kept)                         | U2 and U12: blocked on VAY-2099 slice 2 plus its own Stripe Connect account. U4 (review at its wave). Non-refundable only on all 3 rooms (exact)                                                                                                                                                                                                                                                                                                                                                                                                            | not in a wave                     | Same as Nirvana                                                                                                            |

**Aether B's OTA handover** (H.2–H.6) depends on P12, P16 and P17, none of
which is built yet.

- **Coordinator's fallback if they are not ready:** Aether B moves direct-only
  and its OTAs stay on legacy.
- **This conflicts with runbook #3042, open decision 7.** Direct-only with OTAs
  on legacy puts one inventory in two systems. v2 would take the direct
  bookings and legacy the OTA bookings, neither would see the other's, so
  rooms can be double-booked.
- The runbook's options are to keep Aether B for a later wave or to hold wave
  1. Flamur decides (open question 3).

**Decided** (Flamur, 2026-10-10):

- **Request mode is built in v2 first** (VAY-2099).
  - Dolcemare and Haigha keep request mode; they are not switched to
    instant.
  - Legacy request mode maps 1:1 to v2 request-mode acceptance once it
    exists. Until then, U12 blocks them, and VAY-2099 slice 1 (pay at
    property) is a wave-1 prerequisite.
  - Slice 2 covers card request mode: authorise, host confirms, then capture
    or void. The later-wave card hotels in request mode (Aether A, Animals,
    Nirvana and Miliways) are blocked on slice 2 plus their own Stripe Connect
    account. They do not switch to instant.
- **Partial-refund tiers are built in v2, executed automatically** (VAY-2100).
  - Haigha's legacy tiers map 1:1.
  - U11 blocks Haigha until VAY-2100 ships; VAY-2100 is a wave-1
    prerequisite.
- **Wave 1 stays** Aether B, Dolcemare and Haigha.
- **Feb-29 seasons** follow option (a), mirroring today (U15).
- **Markups** go through the native Channex adjustment (U9).
- **Tiga's OTA meal plan** is closed in its later wave's handover.

## Legacy model: what guests saw

Source: `apps/pms-api` (Python). Prices are per room per night in **major
units**, computed live with `float` and `round(x, 2)`.

| Legacy input (`pms.room_types` unless noted)                                                                  | Meaning in the direct booking engine                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_rate`                                                                                                   | Night price when no season matches. If it is 0, the lowest positive season `rate` over **all** seasons (including those missing a bound).                                                                                                                                                                                                                                                                                                                                                                   |
| `seasons[]` `{name, tier, from, to, rate, minStay, maxStay, occupancyRates}`                                  | Yearly ranges (`2024-MM-DD` or `MM-DD`) that may wrap New Year. The first covering season with a truthy `rate` wins. `occupancyRates["<adults>"]` replaces it; a `""` value falls through to the base price. A season with a `02-29` bound matches **nothing** in non-leap years (below).                                                                                                                                                                                                                   |
| `daily_rates{"YYYY-MM-DD": amount}`                                                                           | Final night price, with no weekend surcharge or occupancy.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `weekend_surcharge` (`"+15%"`)                                                                                | Percent on Friday and Saturday nights (Python `weekday()` 4 and 5). Negative or unparseable values count as 0.                                                                                                                                                                                                                                                                                                                                                                                              |
| `flexible_rate_enabled`, `non_refundable_enabled`, `non_refundable_discount`, `non_refundable_rate`           | NR night = flexible × (1 − d%) when d > 0, else the static NR rate when > 0, else flexible. With flexible disabled, NR = flexible.                                                                                                                                                                                                                                                                                                                                                                          |
| `monthly_rates`                                                                                               | **Dead.** Removed from the lookup in `42a678b84`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `hotels.last_minute_discount`, room `last_minute_discount`                                                    | `int(pct)` off the room total, by days before arrival. The hotel switch is the master; a non-empty room tier list replaces the hotel's; a room can opt out.                                                                                                                                                                                                                                                                                                                                                 |
| season `minStay` / `maxStay`                                                                                  | Enforced for direct bookings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| room `min_stay`, `max_stay`, CTA, CTD                                                                         | **Channex only.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `minimum_advance_days`                                                                                        | Rejects check-in sooner than N days away.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cancellation_policies` (hotel; 7 free days if no row), room `flexible_cancellation_type`, `partial_refund_*` | Server refund rules (mapping below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rate_payment_methods`, `hotel_payment_settings`, booking-engine flags                                        | **Server-enforced** (`booking_service.py:450-460`). `rate_payment_methods` is a dict keyed by rate option, `{"flexible":[…],"nonrefundable":[…]}`. A null dict or a missing key means the hotel's methods; an empty array means nothing is bookable for that option. A method must be in the option's list **and** enabled for the hotel. Values (the last legacy room form): `card` (own Stripe Connect account or the `vayada` platform account), `pay_at_property`, `bank_transfer`, `xendit`, `paypal`. |
| `rate_deposit_settings`                                                                                       | Deposit = round(total × p%, 2), paid online at booking; the balance is paid at the property, and pay at property is refused. A paid cancellation keeps `max(deposit, penalty)`.                                                                                                                                                                                                                                                                                                                             |
| PMS `hotels.instant_book`                                                                                     | `false` means request mode: the host confirms each booking (card bookings are held for manual capture). The import maps it to target `acceptance_mode = 'request'`.                                                                                                                                                                                                                                                                                                                                         |
| `meal_plans[]`, `channex_channel_markups`                                                                     | **OTA only**, applied on the Channex push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `max_occupancy`, `max_adults`, `max_children`                                                                 | Capacity only. Children never change the price. Legacy has no child-age policy.                                                                                                                                                                                                                                                                                                                                                                                                                             |

Legacy has no taxes, fees or extra-guest charges. Add-ons and promo codes are
Booking-owned and outside this ticket.

**Feb-29 bounds, verified with the real legacy code.**

- `_season_covers_date` (`room_type_repo.py:236-256`) moves both bounds into
  the stay's year with `.replace(year=…)`. A `02-29` bound raises in a
  non-leap year and the function returns `False`. In 2025–2027 such a season
  therefore matches **no** date, not just Feb 29, and its `minStay`/`maxStay`
  are unused.
- Running the extracted functions on a "Nov 1 – Feb 29" season gives:
  - 2026-12-15, 2027-01-20 and 2027-02-28 are priced at base;
  - 2028-01-20 and 2028-02-29 get the season price.
- `_get_lowest_season_rate` still counts that season's `rate` when the base is 0.

**Authoritative legacy quote.** `POST /{slug}/bookings/quote` and booking
creation both run:

1. `_prepare_booking_context` (`booking_service.py:380-459`): stay rules,
   sellability, minimum advance days, guest mix and methods.
2. `_compute_booking_pricing`:
   - per night `resolve_rate`, then the NR rule, each rounded `round(…, 2)`;
   - `round(round(Σ, 2) × rooms, 2)`;
   - last-minute `round(total × int(pct)/100, 2)`;
   - then add-ons and promo.

## Pricing-v2 target

There is one `PricingConfiguration` per room type, published as a
whole-property snapshot `{currency, rooms[], ownerReferences:{finance,
charges}}`.

- **Money and modes.** Amounts are integer minor-unit strings, and calendar
  prices must be positive. Each offer uses one price mode; date overrides may
  flatten it.
- **Price per night.** Date override > season > month > base, then the
  weekday adjustment (ISO Monday = 0); a date override skips its own offer's
  adjustments. A linked offer adjusts its parent's room component, including
  a parent override. Every step rounds half-up.
- **Seasons and restrictions.**
  - Price seasons and restriction seasons are separate lists of recurring
    `MM-DD` ranges, compared as strings and never overlapping.
  - Restrictions read minimum stay and CTA at arrival, CTD at departure, and
    maximum stay and stop-sell on every night. Each rule needs `max ≥ min`.
- **Booking terms per offer.**
  - Cancellation is `non_refundable`, or `flexible` with
    `free_until_days_before_arrival`, a required
    `freeCancellationDeadlineDays`, and optional `partial_refund` tiers.
  - Payment is `full` or `deposit`, with `acceptedMethods` ⊆
    `{card, pay_at_property}`.
- **Cancellation at runtime.** v2 has no automatic refunds today. The online
  guest cancellation refuses `partial_refund` and paid bookings ("contact the
  property"), and staff refund by hand (`financeManualBookingRefund.ts`).
  VAY-2100 adds automatic execution of partial-refund tiers.
- **Acceptance mode today.** Instant only (`storePricingAcceptance.ts:41`).
  VAY-2099 adds request mode.
- **Finance readiness.** `lockFinanceReplacementPricingReadiness` refuses a
  deposit term, a currency other than `default_currency`, and a property with
  no executable method. It does not compare each offer's `acceptedMethods`;
  public payment needs both.
- **Card.**
  - It needs a property-scoped Stripe account: details submitted,
    `card_payments` active, eligible for the currency, with unrevoked
    execution evidence.
  - It also needs the acceptance flag, and covers instant booking only.
- **Staleness.** A publication serves quotes only while its three source
  tokens (rooms, terms, finance) are current (`currentPricingPublication.ts`).
  - Any change makes its offers unavailable until a republish ("Save prices"
    republishes), and no alert fires.
  - **Bug** (pricing stream follow-up): every Stripe `account.updated` webhook
    writes `lastStripeEventId` and reorders capabilities, which stales every
    card hotel. VAY-2088 (#3027, P10 a) fixes it.
- **Readiness since #2941.** With a publication, the property's PMS pricing
  source and mandatory-charge confirmation come from the publication and its
  charge declaration.

## Field mapping

Fidelity is one of:

- **exact**;
- **safe**: the nearest safe equivalent, recorded as a `review` finding;
- **drop**: not carried;
- **block**: no publication until the source is fixed or a decision is
  recorded.

### Rooms, offers and price calendar

| Legacy                                                                   | pricing-v2                                                                                                                                                                                                                                                 | Fidelity                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Active room type with a bookable option                                  | One configuration. `roomTypeId` is the legacy ID (preserved by the import); capacity comes from the imported room facts                                                                                                                                    | exact                                                         |
| No bookable option, or no positive price                                 | Omitted (unpriced, as in legacy)                                                                                                                                                                                                                           | exact                                                         |
| Amount `x`                                                               | `Decimal(str(x)) × 100` must be an integer                                                                                                                                                                                                                 | exact; otherwise **block**                                    |
| Children                                                                 | `adultFromAge` = the hotel's own child-policy age, else 18. Neither the legacy nor the target schema has one today, so 18 for all. One band with `"0"`, counted toward capacity.                                                                           | exact for price; U14                                          |
| Flexible option                                                          | `legacy-flexible`: independent, `room_only`, charge `"0"`                                                                                                                                                                                                  | exact                                                         |
| NR via discount d                                                        | `legacy-non-refundable`, linked at −d×100 basis points, restrictions `inherit`                                                                                                                                                                             | exact within rounding; **block** if d ≥ 100                   |
| NR via static rate                                                       | Independent offer with a flat base, no seasons or weekdays; own copy of the restrictions                                                                                                                                                                   | exact                                                         |
| NR only                                                                  | One independent offer with the full calendar                                                                                                                                                                                                               | exact                                                         |
| `base_rate` (0 → the lowest positive `rate` over all seasons)            | `calendar.base`                                                                                                                                                                                                                                            | exact                                                         |
| Season with a positive `rate` and both bounds                            | `calendar.seasons[]`                                                                                                                                                                                                                                       | exact                                                         |
| Season without a `rate` or a bound                                       | No price season; its stay rules still map                                                                                                                                                                                                                  | exact                                                         |
| `occupancyRates`                                                         | `occupancy` mode with arrays for 1..adults. A missing key takes the season `rate`; `""` takes the base; everything else repeats its flat amount                                                                                                            | exact for single rooms; **block** on a 0 value                |
| Overlapping seasons (including New-Year-wrap cases the validator missed) | n/a                                                                                                                                                                                                                                                        | **block** (U10), checked at T-2                               |
| Season with a `02-29` bound                                              | **No** v2 price season and **no** restriction season (legacy cannot build it in non-leap years). Its `rate` still counts for the base-0 lowest-season fallback. Never pass `02-29` as a v2 bound: the `MM-DD` string comparison would wrongly cover Feb 28 | exact for 2025–2027 (U15, decided option (a))                 |
| Future `daily_rates` with value > 0                                      | `calendar.dates[]`, flat                                                                                                                                                                                                                                   | exact                                                         |
| `daily_rates` with value ≤ 0                                             | Restriction date with `stopSell`                                                                                                                                                                                                                           | exact                                                         |
| Past `daily_rates`                                                       | Dropped                                                                                                                                                                                                                                                    | drop                                                          |
| `weekend_surcharge` +p%                                                  | Weekdays 4 and 5 at p×100 basis points (none when p ≤ 0)                                                                                                                                                                                                   | exact within rounding; **block** for non-integer basis points |
| `monthly_rates`                                                          | Not mapped                                                                                                                                                                                                                                                 | drop (dead in legacy)                                         |
| `meal_plans`, channel markups                                            | Not mapped                                                                                                                                                                                                                                                 | drop (U9)                                                     |
| Last-minute discounts                                                    | Not carried before go-day                                                                                                                                                                                                                                  | drop (U13)                                                    |

### Stay rules

Flexible owns the rules; NR inherits or copies them.

| Legacy                       | pricing-v2                                                 | Fidelity                                                   |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Season `minStay` / `maxStay` | `restrictions.seasons[]`                                   | exact                                                      |
| Room `min_stay` / `max_stay` | Base rules and the season fallback, as in the Channex push | **safe** U5 (decided); **block** when a combined max < min |
| Room CTA / CTD               | Base rules                                                 | **block** if true (it would close direct sales)            |
| `minimum_advance_days > 0`   | None                                                       | **safe** U6                                                |
| Operating periods            | Not pricing: the cohort operating calendar owns them       | n/a                                                        |

### Booking terms: cancellation

Checked against the real `parseFlexibleCancellationTerms`. Every mapped shape
passes. A `partial_refund` without tiers, more than 10 tiers, or a
window-field percent of 0 or 100 fails, so the mapping never emits those.

| Legacy (enforced server rule)                                                                     | v2 terms                                                                                                                                      | Fidelity                                                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| NR option                                                                                         | `non_refundable`                                                                                                                              | exact                                                                                                               |
| Hotel: `free_cancellation_days` d, no partial refund                                              | `flexible`, deadline d                                                                                                                        | exact                                                                                                               |
| Hotel: d plus partial refund p > 0 after the deadline                                             | `partial_refund`, deadline d, tiers `[{d,100},{0,p}]` (passes)                                                                                | exact (1:1) once VAY-2100 executes tiers automatically; **block** until then (U11)                                  |
| Room `partial_refund` with tiers (≤ 10)                                                           | `partial_refund` with the same tiers. Deadline = the largest day count among the 100% tiers, else 365                                         | exact (1:1) once VAY-2100 executes tiers automatically; **block** until then (U11); **block** if more than 10 tiers |
| Room `partial_refund` window only: `pct or 50` when ≥ `window or 30` days out, else 0, never 100% | `partial_refund`, tiers `[{window, pct}]` plus the window fields when pct is 1–99 (passes). Deadline 365, so no free cancellation is promised | exact (1:1) once VAY-2100 executes tiers automatically; **block** until then (U11)                                  |
| Displayed `cancellation_policy` text                                                              | Not copied; the enforced numbers win                                                                                                          | **safe**: flagged when its "N days" differs                                                                         |

### Booking terms: payment

Effective legacy methods per rate option are the option's list, or the
hotel's methods when the dict is null or the key is missing, intersected with
the hotel-enabled methods. An empty array means nothing is bookable for that
option; that per-hotel check is pending the follow-up read. Pay at property is
removed when there is a deposit. v2 is always `{kind:"full",
acceptedMethods}`.

| Legacy effective method or rule                       | v2                                                                                      | Fidelity                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pay_at_property`                                     | `pay_at_property`                                                                       | exact                                                                                       |
| `card`, own Stripe Connect account                    | `card`                                                                                  | exact. If G3 fails, the hotel is suspended, never downgraded                                |
| `card`, `vayada` platform account                     | None: no platform-account card in v2                                                    | the hotel waits for a later wave until it has its own onboarded Stripe Connect account (U2) |
| `xendit`                                              | `card` if a property Stripe account is ready in the currency                            | **safe** (U3), else **block**                                                               |
| `bank_transfer`, `paypal`                             | Dropped                                                                                 | **safe** if another method remains, else **block** (U4)                                     |
| No effective method                                   | Offer omitted (legacy could not book it)                                                | exact                                                                                       |
| Deposit p%, including 100%                            | `[card]`, full prepayment                                                               | **safe** U1 (decided)                                                                       |
| Request mode (`instant_book = false`), **any** method | v2 request-mode acceptance, 1:1. VAY-2099 slice 1 for pay at property, slice 2 for card | **block** until the matching VAY-2099 slice ships (U12)                                     |

## Unrepresentable and lossy (dry-run finding codes)

- `review`: allowed only with an approved plan digest that lists it.
- `block`: no publication.

| Code | Legacy behavior                                                                               | Nearest safe v2 equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Severity                                      |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| U1   | Deposit p% online, balance at the property; a paid cancellation keeps `max(deposit, penalty)` | Full card prepayment (decided). Same total; the hotel never collects less upfront. The retention minimum is lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | review                                        |
| U2   | Card on the `vayada` platform account                                                         | None: no platform-account card in v2. The hotel stays on legacy until it has its own Stripe Connect account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | not in a wave                                 |
| U3   | Xendit                                                                                        | Stripe card if it is ready in the currency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | review, else block                            |
| U4   | Bank transfer, PayPal                                                                         | Dropped when another method remains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | review, or block if sole                      |
| U5   | Room-level stay rules on OTAs only                                                            | Applied to both channels (decided). CTA or CTD true, or max < min, blocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | review / block                                |
| U6   | `minimum_advance_days`                                                                        | None (same-day cutoff covers N ≤ 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | review                                        |
| U7   | Multi-room bookings price occupancy by the party's **total** adults                           | v2 prices each room by its own guests. Covered by one listed multi-room gate sample                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | info                                          |
| U8   | Float `round(x, 2)` per step                                                                  | Integer half-up, within the tolerance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | info                                          |
| U9   | OTA meal-plan rate plans, and per-channel markups on the Channex push                         | **Meal plans:** dropped at import, and the OTA rate plans are **closed or deactivated** at that hotel's H.5, before the first push ("not bound" is not "closed": an unbound rate plan may keep its last-pushed ARI). **Markups:** a handover step, not dropped. The v2 published-offer target sends the inclusive total with **no** channel markup by design ("Amount ownership and dispatch" in [offer targets](channex-published-offer-targets.md)). `PMS_CHANNEX_MARKUPS_MODE` and `update_markups` only write the old target's `pms.channel_rate_plan_mappings.markup_percent`. The owner is the native Channex channel-level price adjustment, configured once per hotel and channel at H.6.1, while the first push's stop-sell holds, never alongside an old-target markup. Markups stay out of v2 offers, so direct prices stay the legacy prices. G5 checks it at H.6.2 | review (meal plans); handover step (markups)  |
| U10  | Source defects: overlapping seasons, occupancy 0, sub-cent amounts, more than 10 refund tiers | None; the hotel's source is fixed before its wave's freeze. More than 12 seasons is **not** a defect: v2 has no season cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | block                                         |
| U11  | Partial-refund tiers (Haigha: 1 room)                                                         | `partial_refund` terms with the legacy tiers 1:1, executed automatically by VAY-2100. Haigha's room is `[{26,100}]` with deadline 26 (decided for parity). VAY-2100 PR1–PR3 (P9) are wave-1 prerequisites for Haigha. PR2, the fix for the v2 online cancel preview that answers `409` today, is needed by all three wave-1 hotels. No-show: legacy room tiers refund nothing after check-in, the same as v2's full no-show penalty                                                                                                                                                                                                                                                                                                                                                                                                                                             | block until P9 (Haigha)                       |
| U12  | Request mode (the host confirms each booking), with any payment method                        | v2 request-mode acceptance, 1:1. Wave 1 (Dolcemare, Haigha, pay at property): blocked on VAY-2099 slice 1 and its flag (P8). Later-wave card hotels (Aether A, Animals, Nirvana, Miliways): blocked on slice 2 plus their own Stripe Connect account (W2.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | block until the matching slice                |
| U13  | Active last-minute discounts                                                                  | Not carried before go-day; owners re-add them afterwards (no new Booking command). Read result: no cohort hotel has active tiers. Nirvana's hotel switch is on with no tiers, which maps to the 0% catch-all with no price effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | review if a hotel gains tiers before its wave |
| U14  | Teens entered as children or adults freely; `max_children` limits only the child count        | v2 asks child ages (≤ 17 are children). Rooms with `max_children` 0 or low may reject families with teens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | review                                        |
| U15  | Season with a `02-29` bound, which legacy never applies in non-leap years                     | No v2 season (price or restriction), mirroring today (Flamur 2026-10-10, option (a)). Per-hotel finding: "approved parity choice: Feb-29 seasons unused (Flamur 2026-10-10)", listing the seasons. G2 needs no divergence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | review (approved)                             |

Promo codes, add-ons and existing bookings' frozen price evidence are
untouched.

## Execution design

### Source rows

The converter reads the cutover source run's attested rows:

- `migration_source_pms.snapshot_rows`: `room_types`, `hotels`,
  `cancellation_policies` and `hotel_payment_settings`;
- `migration_source_booking.snapshot_rows`: `booking_hotels` and the
  payment flags.

It re-verifies checksums the way `productionPmsSnapshotReader` does.

Why not the imported rows:

- they are lossy: deltas, dropped unbounded seasons, NR ignoring
  `flexible_rate_enabled`, raw occupancy;
- they are mutable after reopen;
- the parity reference reads the attested rows.

A drift check compares the fields the imported `room_attributes.legacyPricing`
carries, and blocks on a mismatch. Hotels join on `booking_hotels.id =
hotels.id`.

### CLI

The tool lives in `apps/api/src/cli/` and follows the
`financeOtaCommissionPreactivation.ts` pattern: per hotel,
`TARGET_DATABASE_URL`, dry run by default.

```bash
npm --workspace vayada-api run pms:legacy-pricing:publish -- \
  --source-run <sourceRunId> --property-id <uuid> --operator-user-id <uuid> \
  [--apply-for-property <uuid> --approved-plan-sha256 <sha>]
npm --workspace vayada-api run pms:legacy-pricing:parity -- \
  --source-run <sourceRunId> --property-id <uuid>
npm --workspace vayada-api run pms:legacy-pricing:parity -- --stale-count
```

- **Dry run.** Writes nothing and prints `legacy-pricing-plan.v1`: snapshot,
  terms, findings, samples and `planSha256`.
  - Finance readiness comes from `lockFinanceReplacementPricingReadiness`
    with the plan's terms, in an always-rolled-back transaction. `prepare`
    would be `denied` without term heads.
  - The digest covers only date-independent content (normalized legacy
    pricing fields, the converter version, the mapped output and the
    findings), so a T-2 approval holds on go-day unless prices change.
- **Apply.** Needs `--apply-for-property` equal to the property, the
  reviewed digest, and no `block` findings. It runs the command chain and
  verifies that the head equals the plan.
- **`--stale-count`** is the monitoring check (see Staleness). The source
  tokens are computed in TypeScript, so this is a counts-only CLI mode
  rather than plain SQL. It reads every property with a published revision,
  recomputes the three tokens with the existing source readers in an
  always-rolled-back transaction, and prints counts only:
  `{published, staleRooms, staleTerms, staleFinance}`.

### Operator actor (D1, approved in principle)

The operator is **Flamur's own admin/platform account**. The commands need a
trusted `RequestContext`, which is rechecked live. That needs:

- an active user;
- an `agency` membership in the hotel's organization, with a role granting
  `pms.rooms_rates.manage` and its assignment row;
- an owner or operator property link;
- the PMS entitlement.

`resolveRequestContext` only works from a WorkOS session, the
[command-service contract](pricing-command-service-contract.md) forbids a
serialized context, and `identity.access.grant` writes the wrong rows. So:

- **The membership.** The VAY-1362 identity import writes Flamur's **real**
  operator membership per cohort property, as a migration action. It uses a
  dedicated `migration_operator` role preset (rooms/rates read and manage)
  plus the assignment row, with no `permissionKeys` and no organization-field
  writes.
- **The context builder.** A narrow, reviewed builder in apps/api reads that
  membership from the database the way the database stage of
  `resolveRequestContext` does, and sets `audit.source = "migration"`. It
  refuses any property outside the run's bound cohort and an aborted run.
- **The window.** Reopen is not a flag, so the window ends when the tool
  removes the membership with `identity.staff.remove` after the final gate.
- **Attribution.** Every `legacy_import` declaration, and every revision,
  draft, terms and audit row, is recorded under Flamur's user.
- **Security review.** The PR that builds this context needs an independent
  security review before Flamur signs off. The CLI principal already holds
  target write credentials, so the builder adds attribution, not privilege.

**Declaration** (the pricing stream, phase-2 slice 1). `declaredVia` is a
TypeScript literal with no consumer and no DB CHECK; it is stored in
`audit_metadata`. The change:

- widen the union to `"save_prices" | "legacy_import"`, plus the store check;
- `legacy_import` requires `legacyImport: {sourceRunId, planSha256}`;
- store a fixed note in `audit_metadata`: _"Declared by Vayada operations on
  the hotel's behalf during the VAY-1362 migration: these are the prices
  guests already saw in legacy, which showed no separate mandatory charges."_
- add tests;
- the HTTP route stays `save_prices` only.

Flamur confirmed that no cohort hotel collects taxes or fees on arrival, so the
declaration is true.

### Idempotency and re-runs

- **Deterministic IDs.** Request and draft IDs derive from `vay2086:`,
  `planSha256`, the property, the base revision and the operator. Lost
  responses replay through the existing receipts and the draft CAS.
- **Head 0:** run the full chain.
- **The tool's own revision, same plan, current:** no-op.
- **The tool's own revision, but stale or a different plan:** publish a new
  revision. This is allowed only while every revision is the tool's own.
- **Anyone else's revision:** refuse with `published_elsewhere`. The tool
  never overwrites owner prices.
- **`stale` mid-chain:** abort this hotel; a re-run starts a new draft.

### Go-day placement (runbook #3042 steps)

The runbook is the authority on order. This design's steps map onto it as
follows.

- **T-2 readiness.** Run the dry run on the dry-run target, approve each
  hotel's digest, and fix `block` sources in legacy before the freeze.
- **F.1** (was F.3): the target's writers and the P18 jobs are paused. The
  tool runs after the imports, through commands over a direct pool.
- **F.3.** The counts-only read must show zero legacy pending requests per
  wave hotel.
- **S.0a → S.0 → S.0b → S.1–S.4:**
  - **S.0a, card hotels only (Aether B):** the Stripe refresh and the
    online-card execution evidence. It runs before S.0 and S.0b: publishing
    binds the Finance source, and a profile projected before card readiness
    does not list card.
  - **S.0:** card hotels use the normal booking-profile publish, never the
    backfill. On conflict, the backfill resets `accepted_methods` to pay at
    property.
  - **S.0b:** first **[GO]** the card acceptance flag (P10 d) and **[GO]**
    the request acceptance flag (P8), each read back. Then, per hotel: dry
    run, digest compare, apply, and G1–G4. A NO-GO means R0 for that hotel.
  - **S.1:** the smoke covers the published prices, the acceptance mode
    (request for Dolcemare and Haigha) and Haigha's tiers.
- **H, per hotel.** In wave 1 the Channex steps apply to Aether B only.
  Dolcemare has no Channex handover in wave 1, and Haigha is direct-only
  (Option N).
  - **H.2:** the per-property Channex takeover (P12, P16, P17). Never enable,
    delete, disable or re-create the Channex property.
  - **H.5:**
    1. Re-run G1–G4. VAY-2088 is live (P10 a), so `account.updated` no longer
       stales the publication.
    2. Close the hotel's OTA-only rate plans (U9 meal plans; none in wave 1).
    3. Run the diff/dry-run.
    4. The first v2 push is `stop_sell=true`; verify its readback for the
       whole horizon.
  - **H.6.1:** configure the native Channex markup now, while the stop-sell
    holds. Legacy's last push already carries the markup, so setting the
    adjustment earlier would sell at about 1.21×. Never combine it with an
    old-target markup.
  - **H.6.2:** run G5. **H.6.3:** activate the published offer target (P16).
- **O.1.** The final gate: G1–G4, G5 where it applies, and the request
  acceptance flag on for request-mode hotels. Then remove the operator
  membership.
- **O.2 watch, and daily for the first week.** Run `--stale-count` (runbook
  "Stale pricing publications"). Vayada ops own it during the waves; the
  `pms:pricing:publication-freshness` alert is still to be built.

### Per-hotel rollback: R1 or R0 (runbook #3042)

- **R1, hand back to legacy.** Available before the hotel's H.2. Choosing
  between R1 and R0 is runbook open decision 1.
- **R0, suspend in the target.** Only the failing hotel is suspended, and
  there is no pay-at-property fallback. The steps:
  1. **Record** the NO-GO report (hashed property) and the failing check.
     Tell the approver and the owner.
  2. **Close its OTAs with a stop-sell or zero availability, with readback.**
     - If its H.5 ran, the first v2 push was `stop_sell=true`; do not
       activate.
     - Otherwise push a stop-sell (or 0 availability) for the whole horizon:
       through H.5's first push without activation, or as a manual Channex
       stop-sell by the cutover commander.
     - Verify the readback.
     - **Never** close a hotel by deleting, disabling or disconnecting its
       Channex property.
     - Keep its booking intake running. OTA bookings made during the freeze
       are only in the feed.
  3. **Suspend:** `PATCH /properties/:propertyId/status` with `suspended`,
     which withdraws public bookability.
  4. **Leave the data.** Revisions stay immutable and are not public;
     reservations stay in the target PMS.
  5. **Fix forward.** For price or terms, the corrected converter republishes
     the tool's own revision (or the owner uses "Save prices", after which the
     tool stops). For card, S.0a or the Finance fix. Re-run the gate until it
     returns GO.
  6. **Reactivate:**
     - re-read readiness;
     - set `active`;
     - ARI dry run, then activate (H.6);
     - serve the booking page from the target (O.1);
     - remove the operator membership.

## Go-day gate (per hotel)

`pms:legacy-pricing:parity` is read-only; any transaction it opens is always
rolled back. It returns GO, NO-GO or REVIEW and exits 0, 2 or 3.

**G1. Publication is current and equals the plan.** The head is the tool's
revision, matches the approved plan, and is served by the current-publication
reader (all three tokens current).

**G2. Quote parity.**

Samples, generated deterministically:

- every room × offer;
- every priced season, on a weekday and on a Friday or Saturday;
- base gaps and up to 20 overrides;
- stays crossing a season, a weekend and the New Year;
- 1, 3 and 7 nights;
- adults 1..capacity for occupancy rooms;
- one stay with a child younger than `adultFromAge`;
- one date about 11 months out;
- single-room samples, with no add-ons or promo, inside the open window;
- **one multi-room occupancy sample** (expected divergence U7).

**Legacy side.** The real legacy Python: a read-only `apps/pms-api` script runs
the `_prepare_booking_context` rule checks (inventory counts excluded) and the
`_compute_booking_pricing` arithmetic on the exported source rows, at the
gate's property-local date. It returns `priced` or `rejected(reason)`.

**New side.** The public quote's amount composition, in an always-rolled-back
transaction (it takes row locks, so it cannot be `READ ONLY`).
`calculateReplacementRoomStay` nightly lines localize mismatches.

**Expected divergences.** Each counts only if the hotel's approved digest lists
the finding:

- U5: legacy priced, v2 rejects for a room-level rule;
- U6: legacy rejects for minimum advance, v2 prices;
- U7: the multi-room sample;
- U13: last-minute arrivals, where legacy is cheaper.

**Rounding.** Legacy converts exactly (`Decimal(str(x)) × 100`). Let k be the
percentage steps applied to a night (weekend, NR), so 0–2.

- Per night: |Δ| ≤ k minor units; fixed-amount nights match exactly.
- Stay total: |Δ| ≤ Σk.

One minor unit is 0.01 rupiah or one cent. A larger difference, or any other
priced/rejected disagreement, is **NO-GO**.

**G3. Finance and Stripe card readiness, per currency (IDR, USD).**

- `finance.payment_settings` exists with `payments_enabled`.
- `default_currency` equals the pricing currency, the
  `property_pricing_settings` currency, the room currency and
  `booking_hotels.currency`.
- Every offer's `acceptedMethods` is a subset of Finance's ready methods, and
  no offer has deposit terms.
- Each `card` offer has online-card readiness `ready` for its currency:
  - a property-scoped Stripe account with details submitted;
  - charges and payouts enabled, and `card_payments` active;
  - eligible for the currency;
  - unrevoked execution evidence.
- `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true` on next-api (a human
  checkbox).
- A legacy online-card hotel without card readiness is NO-GO, which leads to
  the per-hotel suspend.
- **Acceptance mode maps 1:1.** The target acceptance mode equals legacy's.
  G3 **allows request mode**:
  - for pay-at-property hotels once VAY-2099 slice 1 is live **and**
    `REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED` is on (a wave-1 **[GO]**
    at S.0b, read back);
  - for card hotels once slice 2 is live.

  A request-mode hotel without its slice and flag is NO-GO (U12).

**G4. Findings.** No `block` findings, and every `review` finding is in the
approved digest.

**G5. Markup smoke at H.6.2, while the first push's stop-sell holds**
(marked-up hotels only: Aether B in wave 1, Aether A and Tiga in their
waves). On one sample date, the rate the marked-up channel shows equals the v2
published total × 1.10. A missing or doubled adjustment is NO-GO for that
hotel's OTA reopen. If the rate cannot be read while the stop-sell holds,
record that as an explicit accepted risk with the go, and check right after
activation with a stop-sell push ready.

## Phase 2 slices (after review)

1. Pricing stream: the converter with fixtures for every row and finding,
   including the parser fixtures above and the U15 Feb-29 rule (no v2 price or
   restriction season; the season still counts for the base-0 fallback; an
   approved-parity finding). Also `declaredVia: "legacy_import"` with tests.
   The wave-1 prerequisites VAY-2099 (request mode) and VAY-2100 (automatic
   partial-refund tiers) are separate tickets with their own workspaces.
2. Pricing stream: the Finance-token staleness fix and republish
   (VAY-2088, P10 a), and the K5 IDR run for the later IDR card hotels (P10 b).
3. D1: the migration context builder (independent security review, then
   Flamur's sign-off) and Flamur's operator membership in the identity
   import.
4. VAY-1362: the source reader, the plan and the dry-run CLI.
5. VAY-1362: apply, the re-run rules and `--stale-count`.
6. VAY-1362: the Python reference and the gate, with CI pinning against
   `quote_booking_request`.
7. Runbook #3042 (coordinator) owns the steps and the P15 rehearsal; this
   design supplies their inputs.

## Open questions

1. **Payment-method mix.** The per-option empty, missing and method counts
   are pending the follow-up read. The "empty option means nothing bookable"
   check waits on it.
2. **P13 native markup.** Confirm it on the staging Channex pair. If it fails,
   runbook open decision 2 chooses between closing that channel's rate plan
   and accepting a 10% lower OTA price.
3. **Aether B without P12, P16 or P17.** The coordinator's fallback is
   direct-only with OTAs on legacy. Runbook open decision 7 says that cannot
   work (one inventory in two systems) and offers a later wave or holding wave
   1. Flamur decides.
4. **Haigha Option N** (runbook open decision 6, pending Flamur): direct-only,
   with `6810de91`'s legacy Channex connection untouched and watched daily.
5. **Haigha's two non-refundable-only rooms.** Confirm that flexible stays
   disabled. If the owner meant them to be flexible, they get legacy's 7-day
   free default.
6. **Stale publications.** Vayada ops watch them during the waves. The
   freshness alert and the cause fixes are owned by
   vay-1543-pricing-single-login-65.
7. **Child age.** Confirm that 18 applies to every hotel: no source holds a
   hotel child-age policy today.
