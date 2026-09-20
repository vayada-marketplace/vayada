# Unified TypeScript pricing and migration

VAY-1538, proposed architecture, 2026-09-07. Supersedes the earlier occupancy-only
proposal in this file. Implementation and activation require the slices below.
Source audit: main `c86fe1b2a03d29df26e3c92243a7632a88672842`.

## Hotel experience

A hotel configures a room's guest pricing, calendar prices, meal inclusion and
cancellation options together, previews actual stays, then publishes a revision.
A preview explains each room-night amount and what each connected channel gets.
A saved draft does not change bookable prices. Publishing shows direct activation
and individual channel delivery status separately; a failed channel is never “synced”.

Example: one guest €100, two €130, three €155. A non-refundable option at 10% less
produces €90, €117 and €139.50. The same rules power the calendar, direct offers,
checkout and outgoing channel prices. Channel-specific adjustments and direct
promotions remain explicit, so final totals can legitimately differ.

## Boundaries and reusable work

PMS owns the room-night evaluator and versioned pricing configuration, exposed
through its existing typed ports. Booking owns stay quotes, promotion selection,
add-ons, taxes, fees and checkout. Distribution adapts PMS evidence to providers.
Use a pure function inside `packages/domain-pms`; no new service, rules language,
or shared database access from Booking. External PMS offers keep their adapter
and authority: do not run Vayada-managed room rules over already priced offers.

| Existing code or contract | Treatment |
| --- | --- |
| `packages/domain-booking/src/bookingPriceCalculation.ts` | Extract reusable nightly resolution to PMS; retain Booking orchestration and exact money helpers. Keep old calculation version during migration. |
| `apps/api/src/domains/pmsChannelDatePrices.ts` | Reuse guarded date commands and revision patterns; migrate channel-scoped semantics explicitly into the new model. |
| `apps/api/src/jobs/pmsChannexAriSchedule.ts` | Extend durable delivery and source fingerprints; do not build another scheduler. |
| `apps/api/src/integrations/channexManagementPlans.ts` | Replace one-occupancy payload assumption; retain provider ownership, mapping and failure guards. |
| `packages/domain-booking/src/bookingPromotions.ts` | Retain promotion rules and selection; consume resolved room charges. |
| `engineering/pms-meal-inclusive-rate-plan-contract.md` | Preserve existing breakfast-inclusive amount and plan identity during migration. |
| `engineering/booking-pms-domain-boundaries.md` | Preserve PMS/Booking ownership and external-provider ports. |
| Public offer selection, VAY-910 and VAY-1529 | Reuse per-room allocation and canonical identities; remove competing price reconstruction after parity. |

## Canonical configuration

A property has an active pricing revision and an optional draft. A revision
contains room/plan configurations and references currency, room facts and guest
policy revisions. Plan IDs are stable; revisions are immutable. Publish uses
optimistic concurrency and an atomic local active-pointer/outbox transaction.
Contract types are discriminated unions, validated on write and consumption.

Each room's root plan chooses exactly one guest-pricing mode:

- `flat`: one room total for all valid compositions, preserving existing rooms.
- `base_adjustments`: base guest count, base room amount and a complete signed
  fixed-amount delta table. Base count has zero delta; no extrapolation.
- `occupancy_table`: independent total room amounts for every supported priced
  guest count. Editing one cell does not change the others.
- `per_person`: one amount multiplied by the counted guests. This is a hotel
  tariff, distinct from a provider's similarly named occupancy selling mode.
- `legacy_extra_guest`: compatibility-only existing threshold and surcharge
  behavior, fully captured in the revision; not offered for new configuration.

Do not convert explicit tables into deltas silently. Mode changes require a
complete replacement and before/after preview, including date and season rules.
An active new mode replaces the old extra-guest charge; they never stack.
For base adjustments, changing the base moves all totals by that amount.
For per-person mode, season/date amounts are per counted guest; label this in UI.
For table mode, seasons and date overrides supply complete replacement tables.

Count adults and other guest types only under the property's confirmed policy;
record that policy revision. Validate adult, child and total capacities separately
from priced count. Missing policy, unsupported composition or missing table rows
makes an offer unavailable, never a cheaper fallback. Child age-band tariffs and
separate infant tariffs are deferred; preserve existing classification semantics.

Meal terms are `room_only` or `breakfast`; root amounts already include the chosen
meal. Changing meal terms does not add a breakfast charge. Existing single
breakfast-inclusive canonical plans retain that meaning. Parallel room-only and
breakfast offers are deferred; do not invent a second plan from one existing price.
The existing non-refundable option derives once from the root plan's resolved
occupancy total and inherits its meal terms. Support one percentage discount;
no arbitrary chains, cycles, derived-to-derived parents or independent derived
calendar overrides in this release. Incompatible configurations remain unmigrated
with a specific reason. Their amounts are not discarded or reinterpreted.

## Evaluation and evidence

Inputs include property, room, plan, local stay date, allocated guest composition,
pricing revision and source-facts revisions. Evaluate every room-night separately:

1. Choose standard or the single matching season schedule. Reject overlapping
   applicable seasons rather than relying on row order.
2. Apply the single applicable weekend adjustment. It is an explicit fixed
   room surcharge across all modes, added after per-person multiplication.
3. A root date override replaces the entire recurring result, including weekend.
   Resolve its mode-specific amount/table and occupancy deltas as applicable.
4. Apply the selected cancellation discount once to the resulting room total.
5. Apply only the distribution adjustment owned by Vayada, where configured.
   A native-provider modifier is applied externally, never also in this step.

For steps 1–3, base adjustments resolve base plus delta; tables select a cell;
per-person multiplies unit price by counted guests; flat uses the room amount.
Removing a date override restores the current recurring schedule. New overrides
are canonical, shared by direct booking and distribution. Existing channel-only
overrides must be previewed as a deliberate parity change before migration;
retain old semantics until that property is activated.

Amounts use existing supported scale-two currency minor units, exact integer
arithmetic and half-up rounding after each percentage step per room-night.
No floating point totals, currency conversion or implied all-currency support.
Reject negative and zero new sellable room-night prices; existing zero-price
configurations need an explicit migration decision and retain old behavior until
then. Currency/room/guest-policy changes require draft revalidation. Model version
changes are explicit: previous aggregate-rounding results may differ by cents.

Output contains amount, currency, plan/meal/cancellation identity, room allocation,
calculation version, pricing/source revisions and an ordered amount breakdown.
Errors distinguish invalid configuration, unsupported composition, stale evidence,
missing price and provider incompatibility; HTTP adapters map them explicitly.

Booking sums these room-night amounts, then keeps existing promotion selection:
highest single automatic discount competes with the valid code; a tie favors the
code. Add-ons, taxes and fees retain their existing documented bases/order;
this rewrite does not silently redefine tax treatment. Evidence includes those
separate components. Display/search must use the offered plan's real total,
not a minimum from a different offer. Quote identity includes each allocated room.
Existing quote expiry and stale-check rules remain; a changed price requires a
new quote and visible acceptance before checkout. Accepted bookings retain their
snapshot. Amendments use a new accepted snapshot, never rewrite the original.

## Channel ownership and delivery

Each provider connection records one strategy: existing Vayada-adjusted variants,
or shared base plans with native channel modifiers (VAY-1547/1549/1550).
Never infer the owner from the channel brand. Preserve existing connections until
migration proves their mapping and modifier behavior. Native modifiers can have
multiple rules; preview only supported/readable rules, otherwise show “provider
adjustment unavailable” and block any claim of verified final-price parity.

Materialize occupancy totals from the evaluator. The Channex adapter must verify
current rate-plan/ARI contracts and supported downstream guest semantics before
activation. Use decimal strings and full occupancy payload fixtures; do not
confuse per-person tariffs with provider occupancy-total tables. Keep derived
calculation in Vayada for this release; never apply it again at the provider.
Restrictions, availability and provider ownership remain independent sellability
guards. Equal room subtotals are required only for matching dates, guests, terms
and adjustment ownership; OTA taxes/promotions can change the final guest total.

Delivery keys include connection, mapping generation, pricing revision and source
fingerprint. Workers resolve active evidence, fence superseded work, serialize
writes per mapping and reconcile after ambiguous in-flight results. Inspect
partial failures/warnings, retry failed items and expose last verified generation.
An HTTP success alone proves neither full acceptance nor downstream OTA delivery.
Preserve historical mapping identities for incoming reservations.

## Migration and rollback

1. Inventory each property's current sources, canonical IDs, date overrides,
   meal/non-refundable behavior, additional guests and channel modifiers. Produce
   a dry-run mapping and explicit unsupported reasons; no automatic reinterpretation.
2. Capture an immutable candidate from a consistent source revision. Dual-read
   shadow evaluation compares representative dates, all occupancies, mixed rooms,
   discounts and channel strategies. Record exact cents and causes of differences.
   No shadow writes to providers. Every intended difference needs recorded approval
   in the property migration record, including date parity and rounding changes.
3. Deploy consumers that understand both versions before enabling new writers.
   Freeze old pricing writes for that property during final capture; reject stale
   UI submissions through API guards. Revalidate sources and rollback snapshot.
4. Prepare provider mappings without replacing active ones where supported. Verify
   capability and readback. If parallel preparation is impossible, require a
   reviewed per-connection transition procedure before activation; block otherwise.
5. Activate the local revision atomically with durable delivery work. This is not
   a distributed transaction: direct booking may switch before channels converge.
   Surface that state, retry/reconcile, and do not declare migration complete until
   required consumers and mappings are verified against the intended revision.
6. Rollback selects preserved compatible configuration and schedules compensating
   provider delivery. Never delete new reservations, accepted quotes or mappings.
   Old code cannot read new modes: runtime downgrade is blocked unless reverse
   mapping is proven. Otherwise roll forward or restore a compatible prior revision
   using the new engine. Keep booking historical readers across either choice.
7. Retire legacy writers/calculators only after migrated-property parity, deployed
   smoke acceptance and the recorded rollback observation window. Retain required
   historical readers. Properties not migrated keep the compatibility path.

## Acceptance examples and delivery slices

| Input | Expected room-night total |
| --- | ---: |
| Base 2 guests €130; deltas 1=-€30, 3=+€25 | €100 / €130 / €155 |
| Above, 10% non-refundable | €90 / €117 / €139.50 |
| Seasonal base €180 plus €20 weekend | €170 / €200 / €225 |
| Above with €120 date base replacing recurring | €90 / €120 / €145 |
| Explicit table €100/€130/€155; edit two guests to €180 | €100 / €180 / €155 |
| €60 per counted guest, 3 guests plus €20 weekend | €200 |
| €50 per-person date override on that weekend, 3 guests | €150 |
| Breakfast-inclusive base €130, 10% non-refundable | €117; no breakfast added |
| Separate standard rooms with 1 and 3 guests | €255 combined |
| €155, non-refundable 10%, Vayada markup 10% | €153.45 |
| Same native markup strategy | Export €139.50; expect €153.45 only with verified native 10% |

VAY-1539 defines contracts and these fixtures. VAY-1540 implements immutable
storage and migration dry-run snapshots. VAY-1541 adds guarded draft/publish APIs.
VAY-1542 implements the pure evaluator and shadow comparisons. VAY-1543 connects
direct offers, quotes, checkout and amendments. VAY-1544 supplies the unified
hotel editor and previews. VAY-1545 adapts channel delivery and generation fencing.
VAY-1546 owns property cutover, rollback rehearsal, deployed validation and gated
legacy retirement, split into narrow PRs. All depend on accepted VAY-1538 design;
each implementation PR should stay around 400 meaningful changed lines.

Retain VAY-1527's completed work; integrate VAY-1528 restrictions, VAY-1529 meal
identity, VAY-1530 meal delivery, VAY-910 allocation and VAY-1547–1550 channel
strategy without duplicate implementations. VAY-505/289 remain regression inputs;
VAY-181/1491 require comparison against existing promotions before further work.
VAY-1521/1093 are optional research, not critical-path rewrite dependencies.

Validation must cover every example, mode switches, overlapping rules, date
removal/year boundaries, guest/currency revision changes, missing counts, tenant
and role denials, quote expiry, old bookings, stale jobs, partial provider failure,
in-flight cutover and rollback after new bookings. Record unit/contract tests,
real deployed UI/API evidence, provider readback and downstream OTA evidence
separately. No real reservations, payments or guest messages in test fixtures.
