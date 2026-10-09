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

- **The go-day gate is per hotel.** It checks quote parity on sample stays
  within the rounding rules, and Finance and Stripe card readiness for the
  hotel's currency.

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
- the operator is Flamur's own platform account (D1).

## Go-day prerequisites

| #   | Prerequisite                                                                                                                                                 | Owner                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| a   | Fix the Finance-token staleness bug, then republish existing card hotels (see "Staleness" below)                                                             | pricing stream            |
| b   | Run K5 with a Stripe test-mode **IDR** connected account. USD-path K5 passed 10/10 on 2026-10-09 (`evidence/vay1543-slice0-20261008/k5-stripe-test-mode.md`) | pricing stream            |
| c   | Refresh the Stripe account and record execution evidence per card hotel (runbook S.0a)                                                                       | VAY-1362 / Finance        |
| d   | A platform PR setting `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true`, flipped with Flamur's explicit go before go-day. K1–K4 are already merged and dark | platform + Flamur         |
| e   | Per-hotel card readiness in the gate (G3)                                                                                                                    | VAY-1362                  |
| f   | Deploy VAY-2085 (#3023) and add IDR to the import's currency copy (see "Currency")                                                                           | VAY-2085 / VAY-1362       |
| g   | Implement D1 (the migration context) after an independent security review                                                                                    | VAY-1362, Flamur sign-off |
| h   | Implement `declaredVia: "legacy_import"`                                                                                                                     | pricing stream            |

The card scope on go-day is instant booking only and full prepayment only.
There is no request-mode card, no automatic refund, and no online cancellation
of a paid booking ([card acceptance](pricing-card-acceptance.md)).

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
card-eligible (`0119`). Stripe's IDR behavior on a connected account is
prerequisite b.

## Legacy model: what guests saw

Source: `apps/pms-api` (Python). Prices are per room per night in **major
units**, computed live with `float` and `round(x, 2)`.

| Legacy input (`pms.room_types` unless noted)                                                                  | Meaning in the direct booking engine                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_rate`                                                                                                   | Night price when no season matches. If it is 0, the lowest positive season `rate` over **all** seasons (including those missing a bound).                                                                                                                                        |
| `seasons[]` `{name, tier, from, to, rate, minStay, maxStay, occupancyRates}`                                  | Yearly ranges (`2024-MM-DD` or `MM-DD`) that may wrap New Year. The first covering season with a truthy `rate` wins. `occupancyRates["<adults>"]` replaces it; a `""` value falls through to the base price.                                                                     |
| `daily_rates{"YYYY-MM-DD": amount}`                                                                           | Final night price, with no weekend surcharge or occupancy.                                                                                                                                                                                                                       |
| `weekend_surcharge` (`"+15%"`)                                                                                | Percent on Friday and Saturday nights (Python `weekday()` 4 and 5). Negative or unparseable values count as 0.                                                                                                                                                                   |
| `flexible_rate_enabled`, `non_refundable_enabled`, `non_refundable_discount`, `non_refundable_rate`           | NR night = flexible × (1 − d%) when d > 0, else the static NR rate when > 0, else flexible. With flexible disabled, NR = flexible.                                                                                                                                               |
| `monthly_rates`                                                                                               | **Dead.** Removed from the lookup in `42a678b84`.                                                                                                                                                                                                                                |
| `hotels.last_minute_discount`, room `last_minute_discount`                                                    | `int(pct)` off the room total, by days before arrival. The hotel switch is the master; a non-empty room tier list replaces the hotel's; a room can opt out.                                                                                                                      |
| season `minStay` / `maxStay`                                                                                  | Enforced for direct bookings.                                                                                                                                                                                                                                                    |
| room `min_stay`, `max_stay`, CTA, CTD                                                                         | **Channex only.**                                                                                                                                                                                                                                                                |
| `minimum_advance_days`                                                                                        | Rejects check-in sooner than N days away.                                                                                                                                                                                                                                        |
| `cancellation_policies` (hotel; 7 free days if no row), room `flexible_cancellation_type`, `partial_refund_*` | Server refund rules (mapping below).                                                                                                                                                                                                                                             |
| `rate_payment_methods`, `hotel_payment_settings`, booking-engine flags                                        | **Server-enforced** (`booking_service.py:450-460`): the method must be in the rate's list (when set) **and** enabled for the hotel. Methods are `card` (own Stripe Connect account or the `vayada` platform account), `xendit`, `pay_at_property`, `bank_transfer` and `paypal`. |
| `rate_deposit_settings`                                                                                       | Deposit = round(total × p%, 2), paid online at booking; the balance is paid at the property, and pay at property is refused. A paid cancellation keeps `max(deposit, penalty)`.                                                                                                  |
| `instant_book`                                                                                                | Request mode holds card bookings for manual capture.                                                                                                                                                                                                                             |
| `meal_plans[]`, `channex_channel_markups`                                                                     | **OTA only**, applied on the Channex push.                                                                                                                                                                                                                                       |
| `max_occupancy`, `max_adults`, `max_children`                                                                 | Capacity only. Children never change the price. Legacy has no child-age policy.                                                                                                                                                                                                  |

Legacy has no taxes, fees or extra-guest charges. Add-ons and promo codes are
Booking-owned and outside this ticket.

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
- **Cancellation at runtime.** v2 has no automatic refunds. The online guest
  cancellation refuses `partial_refund` and paid bookings ("contact the
  property"), and staff refund by hand (`financeManualBookingRefund.ts`).
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
    card hotel. That is prerequisite a.
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

| Legacy                                                                                   | pricing-v2                                                                                                                                                                       | Fidelity                                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Active room type with a bookable option                                                  | One configuration. `roomTypeId` is the legacy ID (preserved by the import); capacity comes from the imported room facts                                                          | exact                                                         |
| No bookable option, or no positive price                                                 | Omitted (unpriced, as in legacy)                                                                                                                                                 | exact                                                         |
| Amount `x`                                                                               | `Decimal(str(x)) × 100` must be an integer                                                                                                                                       | exact; otherwise **block**                                    |
| Children                                                                                 | `adultFromAge` = the hotel's own child-policy age, else 18. Neither the legacy nor the target schema has one today, so 18 for all. One band with `"0"`, counted toward capacity. | exact for price; U14                                          |
| Flexible option                                                                          | `legacy-flexible`: independent, `room_only`, charge `"0"`                                                                                                                        | exact                                                         |
| NR via discount d                                                                        | `legacy-non-refundable`, linked at −d×100 basis points, restrictions `inherit`                                                                                                   | exact within rounding; **block** if d ≥ 100                   |
| NR via static rate                                                                       | Independent offer with a flat base, no seasons or weekdays; own copy of the restrictions                                                                                         | exact                                                         |
| NR only                                                                                  | One independent offer with the full calendar                                                                                                                                     | exact                                                         |
| `base_rate` (0 → the lowest positive `rate` over all seasons)                            | `calendar.base`                                                                                                                                                                  | exact                                                         |
| Season with a positive `rate` and both bounds                                            | `calendar.seasons[]`                                                                                                                                                             | exact                                                         |
| Season without a `rate` or a bound                                                       | No price season; its stay rules still map                                                                                                                                        | exact                                                         |
| `occupancyRates`                                                                         | `occupancy` mode with arrays for 1..adults. A missing key takes the season `rate`; `""` takes the base; everything else repeats its flat amount                                  | exact for single rooms; **block** on a 0 value                |
| Overlapping seasons (including New-Year-wrap cases the validator missed), `02-29` bounds | n/a                                                                                                                                                                              | **block** (U10)                                               |
| Future `daily_rates` with value > 0                                                      | `calendar.dates[]`, flat                                                                                                                                                         | exact                                                         |
| `daily_rates` with value ≤ 0                                                             | Restriction date with `stopSell`                                                                                                                                                 | exact                                                         |
| Past `daily_rates`                                                                       | Dropped                                                                                                                                                                          | drop                                                          |
| `weekend_surcharge` +p%                                                                  | Weekdays 4 and 5 at p×100 basis points (none when p ≤ 0)                                                                                                                         | exact within rounding; **block** for non-integer basis points |
| `monthly_rates`                                                                          | Not mapped                                                                                                                                                                       | drop (dead in legacy)                                         |
| `meal_plans`, channel markups                                                            | Not mapped                                                                                                                                                                       | drop (U9)                                                     |
| Last-minute discounts                                                                    | Not carried before go-day                                                                                                                                                        | drop (U13)                                                    |

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

| Legacy (enforced server rule)                                                                     | v2 terms                                                                                                                                      | Fidelity                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| NR option                                                                                         | `non_refundable`                                                                                                                              | exact                                         |
| Hotel: `free_cancellation_days` d, no partial refund                                              | `flexible`, deadline d                                                                                                                        | exact                                         |
| Hotel: d plus partial refund p > 0 after the deadline                                             | `partial_refund`, deadline d, tiers `[{d,100},{0,p}]` (passes)                                                                                | **safe** U11                                  |
| Room `partial_refund` with tiers (≤ 10)                                                           | `partial_refund` with the same tiers. Deadline = the largest day count among the 100% tiers, else 365                                         | **safe** U11; **block** if more than 10 tiers |
| Room `partial_refund` window only: `pct or 50` when ≥ `window or 30` days out, else 0, never 100% | `partial_refund`, tiers `[{window, pct}]` plus the window fields when pct is 1–99 (passes). Deadline 365, so no free cancellation is promised | **safe** U11                                  |
| Displayed `cancellation_policy` text                                                              | Not copied; the enforced numbers win                                                                                                          | **safe**: flagged when its "N days" differs   |

### Booking terms: payment

Effective legacy methods are the rate's list (or the hotel's methods when the
list is null), intersected with the hotel-enabled methods. Pay at property is
removed when there is a deposit. v2 is always `{kind:"full",
acceptedMethods}`.

| Legacy effective method or rule    | v2                                                           | Fidelity                                                     |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `pay_at_property`                  | `pay_at_property`                                            | exact                                                        |
| `card`, own Stripe Connect account | `card`                                                       | exact. If G3 fails, the hotel is suspended, never downgraded |
| `card`, `vayada` platform account  | `card` once a property Stripe account is ready               | **block** (U2)                                               |
| `xendit`                           | `card` if a property Stripe account is ready in the currency | **safe** (U3), else **block**                                |
| `bank_transfer`, `paypal`          | Dropped                                                      | **safe** if another method remains, else **block** (U4)      |
| No effective method                | Offer omitted (legacy could not book it)                     | exact                                                        |
| Deposit p%, including 100%         | `[card]`, full prepayment                                    | **safe** U1 (decided)                                        |
| Card with `instant_book = false`   | n/a: v2 card is instant only                                 | **block** (U12)                                              |

## Unrepresentable and lossy (dry-run finding codes)

- `review`: allowed only with an approved plan digest that lists it.
- `block`: no publication.

| Code | Legacy behavior                                                                                               | Nearest safe v2 equivalent                                                                                                                                                                                                                              | Severity                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| U1   | Deposit p% online, balance at the property; a paid cancellation keeps `max(deposit, penalty)`                 | Full card prepayment (decided). Same total; the hotel never collects less upfront. The retention minimum is lost                                                                                                                                        | review                   |
| U2   | Card on the `vayada` platform account                                                                         | None until a property Stripe account is ready                                                                                                                                                                                                           | block                    |
| U3   | Xendit                                                                                                        | Stripe card if it is ready in the currency                                                                                                                                                                                                              | review, else block       |
| U4   | Bank transfer, PayPal                                                                                         | Dropped when another method remains                                                                                                                                                                                                                     | review, or block if sole |
| U5   | Room-level stay rules on OTAs only                                                                            | Applied to both channels (decided). CTA or CTD true, or max < min, blocks                                                                                                                                                                               | review / block           |
| U6   | `minimum_advance_days`                                                                                        | None (same-day cutoff covers N ≤ 1)                                                                                                                                                                                                                     | review                   |
| U7   | Multi-room bookings price occupancy by the party's **total** adults                                           | v2 prices each room by its own guests. Covered by one listed multi-room gate sample                                                                                                                                                                     | info                     |
| U8   | Float `round(x, 2)` per step                                                                                  | Integer half-up, within the tolerance                                                                                                                                                                                                                   | info                     |
| U9   | OTA meal-plan rate plans and channel markups                                                                  | Dropped at import. Those OTA rate plans are **closed or deactivated** in the Channex handover before H.5. "Not bound" is not "closed": an unbound OTA rate plan may keep its last-pushed ARI and keep selling. Verify each is closed                    | review                   |
| U10  | Source defects: `02-29` bounds, overlapping seasons, occupancy 0, sub-cent amounts, more than 10 refund tiers | None. Fix in legacy before the freeze                                                                                                                                                                                                                   | block                    |
| U11  | Partial refunds, applied automatically and including no-shows                                                 | `partial_refund` terms as mapped above. On v2, cancellation of these bookings is manual (guests are told to contact the property; staff refund by hand), and the no-show penalty is the full amount. The hotel must accept manual cancellation handling | review                   |
| U12  | Card in request mode                                                                                          | None. Switch the hotel to instant before go-day                                                                                                                                                                                                         | block                    |
| U13  | Active last-minute discounts                                                                                  | Not carried before go-day; owners re-add them afterwards (no new Booking command). A counts-only read per hotel comes next. Last-minute gate samples are listed divergences                                                                             | review                   |
| U14  | Teens entered as children or adults freely; `max_children` limits only the child count                        | v2 asks child ages (≤ 17 are children). Rooms with `max_children` 0 or low may reject families with teens                                                                                                                                               | review                   |

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

### Go-day placement

Input for the coordinator's runbook update.

- **T-2.** Run the dry run on the `target:cutover:dry-run` target. Approve
  each digest. Fix `block` sources in legacy before the freeze.
- **S.0, with one change.** Card hotels publish their bookability profile
  through the normal profile publish, not the
  `target:booking-public-bookability:backfill`. On conflict, the backfill
  resets `accepted_methods` to pay at property (stack).
- **S.0a, card hotels (prerequisite c).** Refresh the Stripe account and
  record online-card execution evidence through Finance's readiness path.
  The import writes neither. This comes before publishing, because publishing
  binds the Finance source.
- **S.0b, publish.** Dry run, compare digests, apply, then G1–G4.
  - It runs after `AWAITING_SMOKE`. Resume-from-smoke only validates the
    smoke report, so parity is unaffected.
  - F.3 still holds: the tool uses commands over a direct pool, after the
    imports.
  - Auto-open then re-plans the rooms that gained offers.
- **S.1–S.4.** The smoke sees the published rates.
- **After H.2–H.4, before H.5.** Re-run the gate. Until prerequisite a
  ships, G1 can flap here, because each `account.updated` stales card
  hotels; the tool republishes its own plan.
- **H.5.** Its ARI push reads the published offers. ARI is not mutating
  before then, so the `pricing.v2.revised` outbox makes no provider writes.
  The U9 OTA rate plans must already be closed.
- **Immediately before O.1.** Final gate. Only GO hotels reopen.
- **O.2 watch, and daily for the first week after the window.** Run
  `--stale-count`. Any non-zero count is investigated. "Save prices" by the
  owner, or the tool for its own revision, republishes.

### Per-hotel suspend and rollback (gate NO-GO)

Only the failing hotel is suspended; the rest of the cohort continues.
Legacy is frozen globally, so that hotel does not sell anywhere until it is
fixed. There is no pay-at-property fallback.

1. **Record.** Keep the NO-GO report (hashed property) and the finding in the
   evidence folder. Tell the go-day approver and the owner.
2. **Keep OTAs closed.** Before H.5:
   - leave the hotel's OTA closeout from the window in place;
   - disable its Channex connection with the per-property `disable` command
     (`POST /api/pms/properties/:propertyId/channex/commands`);
   - confirm in the H.5 ARI dry run that it has no outgoing ARI.
3. **Suspend.** Use the platform admin lifecycle command
   `PATCH /properties/:propertyId/status` with `suspended`. This withdraws
   public bookability. O.1 skips the hotel: its legacy URL and custom domain
   keep the maintenance page, or redirect to an unavailable page.
4. **Leave the data.** Revisions are immutable and not public while the hotel
   is suspended. Existing reservations stay in the target PMS for the owner
   and staff.
5. **Fix forward.**
   - Price or terms cause: corrected converter → the tool republishes its
     own revision. Or the owner uses "Save prices", after which the tool
     stops.
   - Card cause: S.0a or the Finance fix.

   Then re-run the gate until it returns GO.

6. **Reactivate.**
   - Re-read readiness (parity or `COHORT_READINESS_SQL`).
   - `PATCH …/status` with `active`.
   - Re-enable Channex, run its ARI dry run, then lift its OTA closeout and
     the domain redirect.
   - Remove the operator membership.

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

**G4. Findings.** No `block` findings, and every `review` finding is in the
approved digest.

## Phase 2 slices (after review)

1. Pricing stream: the converter with fixtures for every row and finding
   (including the parser fixtures above), and `declaredVia: "legacy_import"`
   with tests.
2. Pricing stream: the Finance-token staleness fix and republish
   (prerequisite a), and the K5 IDR run (prerequisite b).
3. D1: the migration context builder (independent security review, then
   Flamur's sign-off) and Flamur's operator membership in the identity
   import.
4. VAY-1362: the source reader, the plan and the dry-run CLI.
5. VAY-1362: apply, the re-run rules and `--stale-count`.
6. VAY-1362: the Python reference and the gate, with CI pinning against
   `quote_booking_request`.
7. Coordinator: runbook steps S.0, S.0a, S.0b, the gate re-runs, the
   per-hotel suspend steps and the O.2 watch; then the rehearsal.

## Open questions

1. **Last-minute (U13).** The counts per cohort hotel are pending; they decide
   how many hotels carry U13.
2. **Payment mix.** Which cohort hotels use the platform card, Xendit, bank
   transfer, PayPal, request mode, deposits or partial refunds? The counts
   read answers this. Each U2, U3, U4 and U12 hotel needs a fix or a decision
   before go-day.
3. **U9 owner.** Who closes the OTA meal-plan and markup rate plans in the
   Channex handover, and how is "closed" verified rather than "unbound"?
4. **Suspended hotels on Channex.** Does the per-property Channex `disable`
   leave OTAs on their last ARI? The closeout must stay until reactivation.
5. **Republishing after reopen.** Who republishes migrated hotels that go
   stale (owners via "Save prices", or ops), and who watches `--stale-count`?
6. **Child age.** Confirm that 18 applies to every hotel: no source holds a
   hotel child-age policy today.
