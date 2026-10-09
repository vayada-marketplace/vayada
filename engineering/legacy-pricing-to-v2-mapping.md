# Legacy pricing to pricing-v2 publication for migrated hotels (VAY-2086)

_Design, phase 1, 2026-10-09. Docs only: nothing here is implemented, merged,
deployed or approved for go-day. The VAY-1362 files cited as "(stack)" live on
the unmerged `fm/vay-1362-cohort-*` branches, not on `main`._

## Decision and scope

Flamur, 2026-10-09: on go-day, after the cohort import and **before reopen**,
each migrated cohort hotel's legacy prices are converted to pricing-v2 and
**published**, so the hotel keeps selling; owners adjust later. Without this, a
cohort hotel has no `pricing_v2` head and no `pms-pricing.v1` plan (the imported
`LEGACY-FLEX`/`LEGACY-NRF` plans keep a NULL contract version), so the VAY-2066
auto-open job marks every room `missing_rate` with a sellable count of 0
([auto-open contract](pms-calendar-auto-open-contract.md)).

Rules this design follows:

- **Command path only.** Publication goes through
  `createReplacementPricingCommands(pool, context)`
  (`apps/api/src/domains/replacementPricingCommands.ts`), the same chain as
  `PricingEditor.save()` and VAY-1943's `publishFirstPricing`:
  stage terms → prepare → save draft → review charges → confirm charges →
  save draft with the declaration attached → publish. No raw inserts into
  `pms.pricing_v2_*` or `booking.pricing_v2_*`.
- **Payment terms copy each hotel's current legacy setting** (Flamur, via the
  VAY-965 coordinator). Pay at property stays pay at property. Online payment
  stays online. A deposit or prepayment rule carries over as closely as v2
  allows. Anything v2 cannot represent exactly gets the nearest **safe**
  equivalent listed below, and the dry run flags it per hotel for review
  before go-day.
- **Parity is a go-day gate.** The legacy quote and the new quote must match
  per hotel on sample stays, within the rounding rules below. Online payment
  also needs per-hotel Finance and Stripe readiness in the gate.

Ownership is unchanged from the ticket. The pricing stream (VAY-1543/2079
worker) owns the mapping and the converter. VAY-1362 owns the go-day
integration and the gate. Releases go through the VAY-965 coordinator.

## Legacy model: what guests saw

Source: `apps/pms-api` (Python). All prices are per room per night, in **major
units** of the room's currency (`NUMERIC(15,2)` columns and JSONB numbers or
strings), computed live per request with `float` and `round(x, 2)`.

| Legacy input (`pms.room_types` unless noted)                                                           | Meaning in the direct booking engine                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base_rate`                                                                                            | Night price when no season matches. When it is 0 and seasons exist, the lowest positive season `rate` is used instead.                                                                                         |
| `seasons[]` `{name, tier, from, to, rate, minStay, maxStay, occupancyRates}`                           | Yearly recurring ranges (stored `2024-MM-DD` or `MM-DD`; may wrap New Year). The first season in array order that covers the night and has a truthy `rate` wins. `occupancyRates["<adults>"]` replaces `rate`. |
| `daily_rates{"YYYY-MM-DD": amount}`                                                                    | Final price for that night. No weekend surcharge and no occupancy.                                                                                                                                             |
| `weekend_surcharge` (`"+15%"`)                                                                         | Percent on Friday and Saturday nights (Python `weekday()` 4 and 5), applied to the season, occupancy or base price. Negative or unparseable values count as 0.                                                 |
| `flexible_rate_enabled`, `non_refundable_enabled`                                                      | Which of the two rate options the room card shows: flexible, non-refundable, or both.                                                                                                                          |
| `non_refundable_discount` (int %), `non_refundable_rate`                                               | NR night = flexible night × (1 − d%) when d > 0, else the static `non_refundable_rate` when > 0, else the flexible night. With flexible disabled, NR = the flexible night with no discount.                    |
| `monthly_rates`                                                                                        | **Dead.** Removed from the price lookup (`42a678b84`). Not what guests saw.                                                                                                                                    |
| `hotels.last_minute_discount`, `room_types.last_minute_discount`                                       | Tiered percent off the room total by days before arrival (property-local today). The hotel switch is the master; rooms may opt out or replace the tiers. Stacks with promo codes only when `stackWithPromo`.   |
| season `minStay`/`maxStay`                                                                             | Enforced for direct bookings: minimum read at arrival, maximum the tightest across the stay.                                                                                                                   |
| `min_stay`, `max_stay`, `closed_to_arrival`, `closed_to_departure`                                     | **Channex only**: room-wide defaults pushed to OTAs; not enforced for direct bookings.                                                                                                                         |
| `minimum_advance_days`                                                                                 | Hides the room when check-in is sooner than N days away.                                                                                                                                                       |
| `cancellation_policies` (hotel), `flexible_cancellation_type`, `partial_refund_*`                      | Server refund rules (below). The room's `cancellation_policy` text was only displayed, and the browser parsed its own deadline from it.                                                                        |
| `rate_payment_methods{flexible,nonrefundable}`, `hotel_payment_settings`, booking-engine payment flags | Methods per rate option (display-level; null means the hotel's methods). Methods: `card` (Stripe Connect or the `vayada` platform account), `xendit`, `pay_at_property`, `bank_transfer`, `paypal`.            |
| `rate_deposit_settings{flexible,nonrefundable}` `{enabled, percentage}`                                | Deposit = round(total × p%, 2), charged online at booking (also in request mode); the balance is due at the property. Pay at property is refused for that rate.                                                |
| `meal_plans[]`, `channex_channel_markups`                                                              | **OTA only.** Meal surcharge and channel markup on the Channex push. Never shown in the direct booking engine.                                                                                                 |
| `max_occupancy`, `max_adults`, `max_children`                                                          | Capacity only. Children never change the price.                                                                                                                                                                |

There are no taxes, fees, city tax or extra-guest charges in legacy pricing.
Add-ons and promo codes are Booking-owned and outside this ticket.

**Authoritative legacy quote** (`booking_service._compute_booking_pricing`,
the path `POST /{slug}/bookings/quote` and booking creation share):

1. Per night: `resolve_rate` (`room_type_repo.py:368`): daily override, else
   season (occupancy for the party's total adults), else base or lowest
   season, then the weekend surcharge, `round(…, 2)`.
2. NR option: `compute_non_refundable_rate` per night, `round(…, 2)`.
3. `room_total = round(round(sum(nights), 2) × rooms, 2)`.
4. Last-minute: `round(room_total × pct/100, 2)` subtracted once.
5. Add-ons, promo and stacking (not part of the parity samples).

The room listing applied last-minute per night instead, which can differ from
the quote by a few cents. The quote is what bookings charged, so the gate
compares against the quote.

## Pricing-v2 target

One `PricingConfiguration` (`version "pricing.v2"`) per room type, published
as a whole-property snapshot `{currency, rooms[], ownerReferences:{finance,
charges}}`. Hand-written parsers reject unknown keys
(`packages/domain-pms/src/replacementPricingConfiguration.ts`). The relevant
facts:

- Amounts are integer minor-unit strings, at most 18 digits. IDR and LKR are
  scale 2, so minor = rupiah × 100. Calendar prices must be positive.
- One price mode per offer (`flat`, `occupancy`, `per_person`,
  `included_guests`) across base, months and seasons. Date overrides may
  flatten it.
- Per night: date override > season > month > base, then the weekday
  adjustment (ISO Monday = 0). A date override skips that offer's weekday and
  link adjustments.
- Seasons are recurring `MM-DD` ranges compared as strings, may wrap New Year
  and must not overlap.
- Linked offers take the parent's room component plus a fixed or basis-point
  adjustment, rounded half-up after each step. Independent offers own their
  restrictions; linked ones may inherit.
- Restrictions are own base rules, recurring seasons and exact dates. Minimum
  stay and CTA are read at arrival, CTD at departure, maximum stay and
  stop-sell on every night.
- Booking terms per offer (`booking.pricing_v2_offer_terms`):
  - cancellation: `non_refundable`, or `flexible` with
    `free_until_days_before_arrival`, optional partial-refund window or
    tiers;
  - payment: `full` or `deposit`, plus `acceptedMethods` ⊆
    `{card, pay_at_property}`.
- Finance `prepare` refuses any `deposit` term
  (`deposit_execution_unavailable`), refuses a currency that differs from
  `finance.payment_settings.default_currency`, and needs at least one
  executable method.
- Card is executable only with a property-scoped, fully onboarded Stripe
  account that is eligible for the currency and has unrevoked execution
  evidence. Public card acceptance also stays behind
  `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED` (default `false`,
  [card acceptance](pricing-card-acceptance.md)).
- **The currency cannot change after the first publication**: the storage
  guard's `allowCurrencyChange` is `false`.
- Last-minute is Booking-owned: `booking.booking_settings.last_minute_discount`
  plus `booking.room_last_minute_heads`. It is applied by the public quote
  (`publicPricingComponents.ts`). The import leaves it at the default
  `{enabled:false}`.

## Field mapping

Each row is marked **exact**, **safe** (nearest safe equivalent, flagged for
review), **drop** (not carried, with a reason), or **block** (the hotel cannot
publish until the source is fixed or an explicit decision is recorded).

### Rooms, offers and price calendar

| Legacy                                                          | pricing-v2                                                                                                                                                            | Fidelity                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Active room type with at least one rate option                  | One configuration, `roomTypeId` = the legacy ID (the import preserves IDs), lowercase UUID                                                                            | exact                                                                                             |
| Room with neither option enabled, or no positive price anywhere | Omitted from the snapshot (it stays unpriced, as it was unsellable)                                                                                                   | exact                                                                                             |
| Currency (room, `booking_hotels.currency`)                      | Snapshot currency; all rooms identical                                                                                                                                | exact. **block** if room, booking-hotel, Finance or `property_pricing_settings` currencies differ |
| Amount `x` (major units)                                        | `Decimal(str(x)) × 10^scale`, which must be an integer                                                                                                                | exact. **block** when it is not (no silent rounding)                                              |
| Capacity                                                        | `capacity` from the imported room facts (`occupancy_limits`)                                                                                                          | exact                                                                                             |
| Children never priced                                           | `adultFromAge: 18`, one band `0–17`, `nightlyMinor "0"`, `countsTowardCapacity: true`                                                                                 | exact for price (see open question 9)                                                             |
| Flexible option                                                 | Offer `legacy-flexible`, independent, meal `room_only` with a `"0"` room charge                                                                                       | exact                                                                                             |
| NR via discount `d`                                             | Offer `legacy-non-refundable`, linked to `legacy-flexible`, `percentage −d×100` bp, restrictions `inherit`                                                            | exact within rounding. **block** if d ≥ 100                                                       |
| NR via static `non_refundable_rate`                             | Independent offer with flat base = that rate and no seasons or weekdays; own restrictions copied from flexible                                                        | exact                                                                                             |
| NR only (flexible disabled)                                     | Single independent offer `legacy-non-refundable` carrying the full calendar, no discount                                                                              | exact                                                                                             |
| `base_rate > 0`                                                 | `calendar.base`                                                                                                                                                       | exact                                                                                             |
| `base_rate = 0` and seasons exist                               | `calendar.base` = the lowest positive season `rate`                                                                                                                   | exact                                                                                             |
| Season with a positive `rate` and both bounds                   | `calendar.seasons[]` `{name, tier, from:MM-DD, through:MM-DD}`                                                                                                        | exact                                                                                             |
| Season without `rate`, or missing a bound                       | No price season (legacy never priced it); its stay rules still map                                                                                                    | exact                                                                                             |
| Any season with `occupancyRates`                                | The offer becomes `occupancy` mode. Each season gets an array for 1..capacity.adults (missing keys = season `rate`). Base and other seasons repeat their flat amount. | exact for single-room stays                                                                       |
| Overlapping seasons (pre-validator data)                        | n/a: v2 rejects overlap                                                                                                                                               | **block**: fix in legacy before freeze                                                            |
| Season bound on `02-29`                                         | n/a: legacy matches nothing in non-leap years; v2 would match                                                                                                         | **block**: move the bound in legacy before freeze                                                 |
| `daily_rates` dated today or later, value > 0                   | `calendar.dates[]` with a flat price                                                                                                                                  | exact                                                                                             |
| `daily_rates` value ≤ 0                                         | Restriction date `stopSell: true`                                                                                                                                     | exact (unsellable on both sides)                                                                  |
| `daily_rates` in the past                                       | Dropped                                                                                                                                                               | drop (no guest can book a past night)                                                             |
| `weekend_surcharge` `+p%` with p > 0                            | `weekdays: [{day:4},{day:5}]` with `percentage p×100` bp                                                                                                              | exact within rounding. **block** if p×100 is not an integer                                       |
| `weekend_surcharge` ≤ 0 or unparseable                          | No weekday rows                                                                                                                                                       | exact (legacy ignored it); info finding                                                           |
| `monthly_rates`                                                 | Not mapped                                                                                                                                                            | drop: dead in legacy; mapping it would change prices                                              |
| `meal_plans`, `channex_channel_markups`                         | Not mapped                                                                                                                                                            | drop for direct booking; see unrepresentable U9                                                   |

### Stay rules (flexible offer's own restrictions; NR inherits or copies)

| Legacy                                     | pricing-v2                                                                                      | Fidelity                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Season `minStay` / `maxStay`               | `restrictions.seasons[]` `minArrivalNights` / `maxStayNights`                                   | exact                                                        |
| Room `min_stay`, `max_stay` (Channex only) | Base `rules` and the fallback for seasons without their own value (the Channex push precedence) | **safe**: now also enforced for direct bookings (U5)         |
| Room `closed_to_arrival` / `_departure`    | Base `rules.closedToArrival` / `closedToDeparture`                                              | **safe** U5. **block** if true (it would close direct sales) |
| `minimum_advance_days > 0`                 | None (no lead-time rule in v2)                                                                  | U6                                                           |
| Operating periods                          | Not pricing: the cohort operating-calendar import owns them                                     | n/a                                                          |

### Booking terms: cancellation

| Legacy (enforced server rule)                                          | v2 terms                                                                        | Fidelity                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| NR option                                                              | `{kind:"non_refundable"}`                                                       | exact                                                                  |
| Flexible, hotel `free_cancellation_days = d`, `partial_refund_pct = 0` | `flexible`, `freeCancellationDeadlineDays: d`                                   | exact                                                                  |
| Flexible, hotel partial `p > 0` after the deadline                     | `flexible`, `flexibleCancellationType: partial_refund`, tiers `[{d,100},{0,p}]` | exact for arrivals before check-in; a no-show is full penalty in v2    |
| Room `partial_refund` with tiers                                       | Same tiers (≤ 10, sorted)                                                       | exact field copy (open question 7: v2 deadline semantics)              |
| Room `partial_refund` window/percent                                   | `partialRefundCancelWindowDays` / `partialRefundAmountPercent`                  | exact for 1–99%; **safe** for 0 or 100%, normalized and flagged        |
| Displayed `cancellation_policy` text                                   | Not copied; the enforced numbers win                                            | **safe**: flagged when its "N days" differs from the enforced deadline |

### Booking terms: payment (copy each hotel's current setting)

Per legacy rate option, the methods are `rate_payment_methods[option]`, else
the hotel's enabled methods. The deposit comes from
`rate_deposit_settings[option]`. v2 payment is always `{kind:"full",
acceptedMethods}`.

| Legacy per rate option                                    | v2 `acceptedMethods` / kind                                                    | Fidelity                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `pay_at_property`, no deposit                             | `pay_at_property`                                                              | exact                                                                                   |
| `card` on a property Stripe Connect account, no deposit   | `card`                                                                         | exact; needs gate G3                                                                    |
| `card` on the `vayada` platform account                   | `card` only once the hotel has a property Stripe account ready; otherwise none | **block** until ready (v2 card is property-scoped). Never downgraded to pay at property |
| `xendit`                                                  | `card`, if the property Stripe account is ready in the currency                | **safe** (still online, different provider), else **block**                             |
| `bank_transfer`, `paypal`                                 | Not offered                                                                    | **safe** when another method remains; **block** if it was the only one                  |
| Deposit p% (online now, balance at property; PaP refused) | `full` + `[card]`: the guest prepays 100% online                               | exact when p = 100; otherwise **safe** U1                                               |

### Last-minute (Booking-owned, carried by the same tool)

Legacy hotel config goes to `booking_settings.last_minute_discount` and room
configs go to room last-minute heads, through their existing Booking writers
under the same operator context.

- `{enabled:false, …}` normalizes to `{enabled:false, stackWithPromo:false,
tiers:[]}`, which is the same behavior.
- Tiers with pct ≤ 0 are dropped (legacy skipped them).
- Percentages with more than 2 decimals, or above 100, **block**.
- Overlapping tiers **block**: v2 rejects them, and legacy's first-match order
  cannot be preserved automatically.

## Unrepresentable and lossy (dry-run finding codes)

Severity `review` means the hotel may publish only with an approved plan digest
that contains the finding. `block` means it cannot publish.

| Code | Legacy behavior                                                                                                    | Nearest safe v2 equivalent                                                                                                                                                                                                                                                    | Severity                           |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| U1   | Deposit p% < 100 charged online, balance at property; on paid cancellation `max(deposit, penalty)` is retained     | Full prepayment by card. Total price unchanged; the hotel never collects less upfront than legacy. Pay at property would remove the guarantee, so it is not the default. Deposit retention minimum is lost: refunds follow the offer's cancellation terms on the full amount. | review (open question 1)           |
| U2   | Card through the `vayada` platform account                                                                         | None until the hotel completes Stripe Connect: v2 card is property-scoped only                                                                                                                                                                                                | block                              |
| U3   | Xendit online payment                                                                                              | Card through Stripe if ready in the currency                                                                                                                                                                                                                                  | review, else block                 |
| U4   | Bank transfer, PayPal (manual, request flow)                                                                       | Dropped when another method remains                                                                                                                                                                                                                                           | review, or block if sole method    |
| U5   | Room-level min/max stay and CTA/CTD only on OTAs                                                                   | Applied to both channels (stricter for direct). Room-wide CTA/CTD = true would close direct sales                                                                                                                                                                             | review; block for CTA/CTD          |
| U6   | `minimum_advance_days` hides near-term arrivals                                                                    | None in pricing-v2: static stop-sell dates do not roll. Same-day cutoff covers N ≤ 1 only                                                                                                                                                                                     | review                             |
| U7   | Multi-room bookings look up season occupancy by the party's **total** adults                                       | v2 prices each room by its own guests (the correct behavior). Parity samples are single-room                                                                                                                                                                                  | info                               |
| U8   | Float half-even `round(x,2)` per step                                                                              | Integer half-up per step; bounded by the tolerance below                                                                                                                                                                                                                      | info                               |
| U9   | OTA meal-plan rate plans (meal surcharge, per room or × max occupancy) and per-channel markups                     | Not created: a meal offer would also appear in direct booking (a product change), and Channex adoption must bind rates explicitly ([offer targets](channex-published-offer-targets.md)). Hand to the Channex handover (open question 6)                                       | review (hotels with meal mappings) |
| U10  | Seasons with a `02-29` bound; overlapping seasons; non-integer basis points; amounts finer than the currency scale | None; fix the legacy source before freeze                                                                                                                                                                                                                                     | block                              |
| U11  | Hotel partial refund applies even after check-in (no-show)                                                         | v2 no-show penalty is the full amount                                                                                                                                                                                                                                         | info                               |
| U12  | Deposit bookings captured immediately even in request mode                                                         | Owned by the card-acceptance flow (instant first); request-mode card is later work                                                                                                                                                                                            | review if request mode             |

Promo codes, add-ons, OTA inbound pricing and legacy price snapshots on
existing bookings are untouched. Accepted bookings keep their frozen evidence.

## Execution design

### Source rows: attested migration source, not the imported projection

The converter reads the **attested source rows** of the cutover's source run:

- `migration_source_pms.snapshot_rows`: `room_types`, `hotels`,
  `cancellation_policies`, `hotel_payment_settings`;
- `migration_source_booking.snapshot_rows`: `booking_hotels`, payment flags.

Each row's checksum is re-verified the way `productionPmsSnapshotReader`
does.

Why not the imported target rows:

- They are an immutable, freeze-proofed copy of exactly what legacy served at
  freeze. They are also the input the parity reference reads, so both sides
  share one source.
- The imported rows are a lossy projection:
  - `daily_rate` is stored as a delta from base;
  - seasons without bounds are dropped;
  - `nonRefundableRate()` ignores `flexible_rate_enabled`;
  - `occupancyRates` only survive in a raw payload.
- The imported rows live in mutable runtime tables, which owners can edit
  after reopen.

As a drift check, the plan compares its inputs with the imported
`room_attributes.legacyPricing` snapshot. A mismatch blocks. Target IDs come
from the import's preserved IDs and `propertyForHotel`.

### CLI

The tool lives in `apps/api/src/cli/` (it needs the apps/api pricing commands),
following `financeOtaCommissionPreactivation.ts`. It is per hotel, takes
`TARGET_DATABASE_URL`, and is a dry run by default:

```bash
npm --workspace vayada-api run pms:legacy-pricing:publish -- \
  --source-run <sourceRunId> --property-id <uuid> --operator-user-id <uuid> \
  [--apply-for-property <uuid> --approved-plan-sha256 <sha>]
npm --workspace vayada-api run pms:legacy-pricing:parity -- \
  --source-run <sourceRunId> --property-id <uuid> --operator-user-id <uuid>
```

- **Dry run.** Reads source rows and target state and builds the plan. Runs
  `prepare` (read-only) to surface Finance's reason. Writes nothing and
  prints `legacy-pricing-plan.v1`:
  - legacy input checksums;
  - the proposed snapshot and terms per offer;
  - last-minute settings;
  - findings with severity;
  - the parity sample list;
  - `planSha256` over the content (not over run IDs, so an unchanged hotel
    keeps its digest from the T-2 rehearsal to go-day).
- **Apply.** Needs `--apply-for-property` equal to `--property-id` and the
  reviewed `--approved-plan-sha256`. It refuses when the digest differs or
  any `block` finding exists. It then runs the command chain with one
  operator context and verifies that the stored head equals the plan.
- **The pure converter** (legacy rows to snapshot, terms and findings) lives
  in `packages/domain-pms` with unit fixtures, owned by the pricing stream.

### Operator actor and the charges declaration

The commands derive the actor from a trusted `RequestContext` and recheck live
access. That means an active `identity.users` row and an active `agency`
membership in the hotel's `hotel_group` organization, with a role granting
`pms.rooms_rates.manage`, an owner/operator property link and the PMS
entitlement (`replacementPricingAuthorization.ts`).

The migration operator is a named Vayada ops user (`--operator-user-id`), not
the hotel owner. The proposal is a time-boxed membership:

1. Before the chain, `identity.access.grant` gives that user an `assigned`
   membership for this one property.
2. `identity.access.revoke` removes it in a `finally` block.
3. Both steps are audited, and the dry run checks that no such membership
   remains.

Rejected alternatives:

- **Acting as the legacy owner.** The owner did not make the declaration.
- **A migration bypass in the authorization helper.** The command-service
  contract forbids migration credentials, and a bypass would widen the trust
  boundary.

`pricing_v2_revisions`, drafts, terms and the charge declaration therefore
record the operator as actor.

**Declaration.** `confirmCharges` takes `declaredVia: "legacy_import"`. Today
`declaredVia` is a TypeScript literal (`"save_prices"`) checked in
`replacementChargeDeclarations.ts` and in the route. There is **no DB CHECK or
enum**: it is stored in `product_audit_events.audit_metadata` (JSONB). The
minimal extension:

- **Command union.** Widen it to `"save_prices" | "legacy_import"`.
- **Required reference.** With `legacy_import`, the command requires
  `legacyImport: {sourceRunId, planSha256}`.
- **Audit note.** It stores a fixed server-side note in `audit_metadata`
  (not caller text): _"Declared by Vayada operations on the hotel's behalf
  during the VAY-1362 migration: these are the prices guests already saw in
  legacy, which showed no separate mandatory charges."_
- **HTTP route.** It keeps accepting only `"save_prices"`, so no hotel user
  can claim an import.

`declaredVia` is already part of the request hash.

### Idempotency and re-runs

- **Deterministic identities.** The draft ID and every request ID (terms per
  offer, charges, publish) derive from `planSha256`, the property and the
  base revision. Lost responses replay through the existing receipts
  (terms `request_hash`, charge `request_id`, publication `request_id`) and
  the draft CAS replay. Resume reads the draft, like `publishFirstPricing`'s
  `PublishProgress`.
- **Head 0.** Run the full chain.
- **Head published by this tool with the same plan.** No-op
  (`already_published`).
- **Head published by this tool with a different plan.** For example, a
  retried go-day after R1 with changed legacy prices. Publish a new revision
  on top, allowed only when every later revision is the tool's own.
- **Head published by anyone else** (the owner after reopen, or onboarding).
  Refuse with `published_elsewhere`. The tool never overwrites owner prices.
- **A `stale` result** (sources moved mid-run). Abort that hotel; a re-run
  starts a new draft with an attempt suffix recorded in the report.
- **Currency.** It cannot be fixed after publication, so every currency check
  is a pre-publication `block`.

### Go-day placement

The new step is **S.0b, "Publish legacy prices"**, in
the go-day runbook (`engineering/legacy-migration-go-day-runbook.md`, stack). It comes after
`target:cutover` pauses at `AWAITING_SMOKE` and after S.0 (hotels active,
bookability profiles published). It comes before S.1, so the manual smoke sees
the published rates on the public booking page.

- Resume-from-smoke only validates the smoke report and does not re-run
  parity, so these writes do not disturb the run's parity evidence.
- The step must finish before H.5: the first ARI push reads published offers.
  ARI is not mutating yet, so the `pricing.v2.revised` outbox causes no
  provider writes.
- The F.3 native-writer pause still holds. The tool writes through commands
  over a direct pool, not HTTP, after the domain imports have committed.
- The next auto-open run re-plans hotels whose rooms gained offers. S.1
  confirms sellable counts above 0.
- **T-2.** Run the dry run against the `target:cutover:dry-run` target. Review
  each hotel's findings and approve its `planSha256`; legacy `block` fixes
  happen before the freeze.
- **Go-day.** Run the dry run, compare the digest, apply, then run the parity
  gate. Keep each report and checksum in the run's evidence folder.

## Go-day gate (per hotel, read-only)

`pms:legacy-pricing:parity` returns GO, NO-GO or REVIEW per hotel. It exits
0 (all GO), 2 (any NO-GO) or 3 (review pending), following `target:parity`.
Reopen needs GO for every hotel that reopens.

**G1. Publication equals the plan.** The stored head is the tool's revision,
and its rooms and terms equal the approved plan, ignoring server-issued
revisions.

**G2. Quote parity.**

- **Samples.** Generated deterministically from the plan:
  - every published room × offer;
  - nights from every priced season, in a weekday and a Friday/Saturday
    variant;
  - base-gap nights;
  - up to 20 daily overrides;
  - stays crossing a season boundary, a weekend and a New-Year wrap;
  - 1, 3 and 7 nights;
  - adults 1..capacity for occupancy-priced rooms, plus one stay with a
    child (proving children stay free);
  - for last-minute hotels, arrivals at each tier's minimum and maximum
    days;
  - one far date (about 11 months out);
  - all within the open calendar window; single room; no add-ons or promo.
  - Samples that legacy rejects (season min/max stay) must also be rejected
    by v2.
- **Legacy side.** The **real legacy Python** computes it: a read-only
  `apps/pms-api` script calls `compute_stay_pricing` and
  `resolve_last_minute_discount`, composed as in `_compute_booking_pricing`,
  on the exported source rows. It uses the gate's property-local booking
  date. A TypeScript port would share the converter author's assumptions. A
  pre-freeze capture of the live API would miss price edits before freeze
  and depends on "today".
- **New side.** The public quote's amount composition (room components with
  last-minute, then charge totals), run in a transaction that is always
  rolled back, so no quote record is written. It cannot be `READ ONLY`:
  the owner readers take `FOR UPDATE`/`FOR SHARE` locks.
  `calculateReplacementRoomStay` nightly lines localize any mismatch.

**Rounding rules.** Legacy amounts become minor units exactly
(`Decimal(str(x)) × 10^scale`). Let k = the number of percentage steps legacy
applied to that night (weekend surcharge, NR discount; 0 to 2).

- Each night: |Δ| ≤ k minor units. Base, season, occupancy, override and
  static-NR nights must match exactly.
- Stay room total before last-minute: |Δ| ≤ Σk.
- After last-minute: |Δ| ≤ Σk + 1. Legacy rounds the discount once on the
  total; v2 rounds per room component.

For IDR (scale 2) a 1-minor-unit difference is 0.01 rupiah. A larger
difference, or one side priced while the other is unavailable, is **NO-GO**.

**G3. Finance and Stripe readiness.**

- `finance.payment_settings` exists with `payments_enabled`.
- `default_currency` = the plan currency = `property_pricing_settings`
  currency = the legacy room and booking-hotel currency.
- Every method in every published offer is executable: `prepare` re-run
  read-only returns verified Finance evidence, and no offer has deposit
  terms.
- For each offer with `card`, Finance's online-card readiness is `ready` for
  that currency: property-scoped Stripe account, onboarding complete,
  charges and payouts enabled, `card_payments` active, currency eligible,
  unrevoked execution evidence.
- `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true` is confirmed on next-api
  (a human checkbox; the CLI cannot read that environment).
- No legacy online method became offline. A hotel whose online payment
  cannot stay online is NO-GO, never silently pay at property.

**G4. Findings.** No `block` findings, and every `review` finding is covered
by the approved digest. A NO-GO hotel must not reopen. The approver either
triggers R1, or suspends that hotel with the platform admin lifecycle command
(as in R1) and fixes forward before reactivating it (open question 10).

## Phase 2 slices (after review)

1. Pricing stream: the pure converter in `domain-pms` with unit fixtures for
   every mapping row and finding, plus the `declaredVia: "legacy_import"`
   extension.
2. VAY-1362: the source reader, plan and dry run CLI, with integration tests
   on a seeded target.
3. VAY-1362: apply (operator membership, command chain, re-run rules) and
   last-minute carry-over.
4. VAY-1362: the Python legacy reference, the parity gate, and a CI test
   pinning the reference against `quote_booking_request` on fixtures.
5. VAY-1362: the runbook step S.0b and gate wiring; the rehearsal on the
   isolated restore.

## Open questions

1. **Deposit default (U1).** Full card prepayment (proposed) or pay at
   property, per hotel?
2. **Operator membership.** Confirm `identity.access.grant`/`revoke` work
   without a lasting WorkOS mirror. Which role preset should grant
   `pms.rooms_rates.manage`?
3. **Last-minute carry-over owner.** This tool through Booking writers
   (proposed), or the VAY-1362 booking import?
4. **Card go-live.** Will card acceptance (K1–K5 and the flag) be live by
   go-day? If not, every online-only cohort hotel fails G3.
5. **No v2 method.** Hotels on the `vayada` platform card, Xendit, bank
   transfer or PayPal (U2–U4): finish Stripe Connect before go-day, or
   decide per hotel?
6. **OTA meal plans and channel markups (U9).** Adopt them into v2 meal
   offers (also visible in direct booking) or close them on Channex before
   the ARI handover?
7. **v2 partial-refund deadline.** Confirm the meaning of
   `freeCancellationDeadlineDays` together with `partial_refund` tiers, so
   the copied tiers refund what legacy refunded.
8. **Room-level restrictions (U5).** Accept the stricter direct-booking
   restrictions, and decide `minimum_advance_days` (U6).
9. **Child age.** `adultFromAge` 18 (price-neutral, proposed), or the hotel's
   published child policy?
10. **Per-hotel NO-GO.** Whole-cohort R1, or suspend only that hotel?
11. **Charges declaration.** Hotels that collect taxes at the property: is
    the "all mandatory charges included" declaration still accurate, or do
    they need a fixed-charge policy after reopen?
12. **IDR prerequisite.** IDR hotels need the IDR support ticket. IDR is not
    in the native pricing-settings currencies the import uses, so those
    hotels get no `property_pricing_settings` row and stay `provisioning`.
