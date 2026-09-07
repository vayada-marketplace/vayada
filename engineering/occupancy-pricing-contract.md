# Occupancy and connected room pricing

VAY-1538. Proposed first-release contract, 2026-09-07. Runtime activation
requires the implementation and validation slices below; this document does
not claim shipped support. Applies to the TypeScript next-stack.

## Product behavior

Hotels choose a base occupancy and enter the total room price for each allowed
priced guest count. They can instead enter fixed adjustments from that base.
These are two editing views of one model: prices entered in the table are
converted to signed currency deltas from the current standard base amount.
The UI explicitly says that changing the base, season or date price moves
every occupancy price by the same amount. Independent seasonal occupancy
tables, percentage occupancy adjustments and true per-person base tariffs are
not part of this release.

Example: two guests €130, one guest €100, three guests €155 stores base
occupancy 2 and deltas {1: -30, 2: 0, 3: 25}. Changing the base to €180 yields
€150/€180/€205. Switching editing views never recalculates or rounds deltas.
Changing the base occupancy requires a preview and explicit save of the new
base amount and complete delta table; no implicit rebasing of dated sources.

The existing non-refundable percentage rule applies to each resolved flexible
occupancy price. This supplies the requested connected booking option without
introducing arbitrary parent-plan graphs or Channex-derived calculations.

## Ownership and persistence

PMS owns a versioned occupancy configuration for a room's canonical flexible
plan: property/room/plan IDs, base occupancy, counted guest types, source room
facts revision, pricing currency revision, configuration revision, and one
signed scale-two amount per priced guest count. Use normalized child rows
with a unique configuration/guest-count key. Preserve existing currency,
authorization, optimistic concurrency, idempotency, audit and outbox patterns.

No configuration means the existing flat/additional-guest model. An active
occupancy configuration replaces the additional-guest rule for that room;
the two must never stack. Enablement previews existing prices and atomically
retires the old additional-guest rule under the same currency/property guard.
Disabling occupancy pricing requires an explicit replacement configuration
preview; never revive an old surcharge invisibly. New rooms remain on the
existing model by default. No bulk automatic migration of hotels.

Require a zero delta at the selected base occupancy (other entries may also
be zero), a complete table from 1 through the maximum priced guest
count, no duplicate counts, and supported currency precision. Reject invalid
or negative resolved nightly room totals; zero retains existing zero-rate
semantics and must not bypass public readiness rules. Capacity or currency
changes invalidate dependent evidence until revalidated. Do not silently trim
the table or extrapolate a missing price.

PMS publishes typed, revisioned nightly room-price evidence. Booking and
Distribution consume that evidence through the established ports/read models.
Keep Channex behind PMS connectivity. Do not add raw PMS-table reads or
Channex imports to Booking routes. Reuse exact minor-unit arithmetic and
percentage rounding from the existing calculator; put reusable room-price
resolution behind the PMS pricing boundary rather than copying it per channel.

## Guest counting and multiple rooms

Reuse the property's current, confirmed guest policy: adults count; children
count only when the policy includes them in priced guests. Infants retain
their existing classification and capacity treatment. Separate child/age-band
prices are deferred. Persist the chosen counted guest types and policy source
revision in pricing evidence; missing or changed policy evidence requires
revalidation, not an assumed adult-only default.

The maximum priced count is bounded by the room's existing adult, child and
total capacity facts and the counted types. Validate the actual composition
against all capacity limits independently of pricing. Unsupported guest
compositions produce an unavailable result, never a cheaper fallback.

Resolve each allocated room separately before summing the stay. Two rooms
occupied by one and three priced guests cost €100 + €155 = €255 per night;
do not charge two copies of the maximum occupancy price. Preserve VAY-910's
allocation/search behavior and include each room's composition in quote identity.

## Nightly calculation order

For occupancy-enabled flexible plans:

1. Resolve the standard or applicable seasonal base amount for the local date.
2. Add the applicable weekend room surcharge.
3. If present, the VAY-1527 flexible-plan date price replaces that whole result,
   including the weekend surcharge. Interpret it as the selected base
   occupancy's room amount. Removal restores the current recurring result.
4. Add the selected occupancy's signed delta once. Do not add the retired
   additional-guest surcharge.
5. For the non-refundable option, apply its existing percentage once to that
   room-night amount, using scale-two half-up rounding.
6. Apply a channel markup once to the resolved rate for that channel, with the
   existing scale-two half-up rule. Direct-booking promotions, add-ons, taxes
   and fees retain their existing ownership and follow the resolved room rate;
   they are not baked into Channex occupancy deltas.

Round each room-night percentage result before summing rooms/nights, so the
same occupancy rate matches the amount distributed for that room-night.
Record calculation version and source revisions. Historical quotes/bookings
retain their accepted calculation version and amounts; never recompute them
with a newly enabled configuration. New quote/checkout attempts and accepted
amendments must validate current pricing evidence using existing stale-quote
and amendment flows, with changed prices shown before acceptance.

First release enables occupancy pricing only for the canonical room-only
flexible plan and its existing non-refundable option. Enabling is blocked
with a specific reason if the room has active meal-inclusive/other plans,
independent non-refundable date overrides, or incompatible provider-derived
relationships. Do not reinterpret or delete those configurations. Extend their
semantics in a separate contract before allowing those combinations. Existing
rooms with these configurations keep their current model.

| Scenario | 1 guest | 2 guests | 3 guests |
| --- | ---: | ---: | ---: |
| Standard flexible, base €130 | €100 | €130 | €155 |
| Non-refundable, 10% discount | €90 | €117 | €139.50 |
| Seasonal base €180 | €150 | €180 | €205 |
| Seasonal base €180 plus €20 weekend | €170 | €200 | €225 |
| Same weekend with €120 date replacement | €90 | €120 | €145 |
| That date, non-refundable 10% | €81 | €108 | €130.50 |

Two standard three-guest non-refundable nights total €279 before separate
charges. With 10% channel markup, that room-night exports €153.45.

## Channex mapping and delivery

Official docs checked 2026-09-07:
[rate plans](https://docs.channex.io/api-v.1-documentation/rate-plans-collection)
and [ARI](https://docs.channex.io/api-v.1-documentation/ari).
Channex distinguishes flat `per_room` selling from occupancy-dependent
`per_person`. Its latter name does not mean multiplying our table amount by
guest count. Use `rate_mode: manual`, all occupancy options, and one primary
option for the base occupancy. Send final room totals using ARI's `rates`
array of occupancy/rate entries instead of the single `rate` field. Keep flat
plans on their existing mode. Do not also configure derived/auto/cascade
arithmetic that would apply the Vayada adjustments twice.

Before changing an existing mapping, validate provider ownership, current
options, downstream channel support and guest-type semantics. An OTA's child
rules may not match a total-guest occupancy option: only enable a mapping with
verified semantic parity. Otherwise keep activation blocked with an actionable
channel-specific reason. Documentation alone does not prove OTA compatibility.

Do not mutate a live plan in place while assuming mappings remain valid.
The provisioning slice must establish a supported update or replacement path,
preserve old mapping identity for historical reservations, and prove staged
readback before switching active delivery. Enabling locally and externally
is a staged transition: keep the previous complete configuration active until
all required consumers/mappings are ready; never expose a half-migrated room.
This requires bounded staging evidence, not an unverified provider-mode flip.

Extend VAY-1527's durable management worker and source-change fingerprint with
occupancy, room and guest-policy revisions. Source changes, removals and local
day rollover resolve current prices when delivered. Preserve VAY-1528 stay
restrictions, existing capability/cutover guards, retries and failure visibility.
ARI can return HTTP 200 with warnings for rejected updates: inspect warnings,
retain failed occupancy/date items for retry, and never label the whole table
synced solely because the HTTP request succeeded. Do not broaden provider
write authority as part of this feature.

## Implementation slices and validation

1. VAY-1538: this contract, source verification and independent review.
2. VAY-1539: typed occupancy source/calculation contracts and fixtures.
3. VAY-1540: versioned storage and atomic mode transitions (after VAY-1539).
4. VAY-1541: guarded commands/read APIs and invalidation (after VAY-1540).
5. VAY-1542: nightly occupancy resolution (after VAY-1539 and VAY-1527).
6. VAY-1543: direct quote, checkout and amendment evidence
   (after VAY-1541, VAY-1542 and VAY-910).
7. VAY-1544: hotel controls and previews (after VAY-1541 and VAY-1542).
8. VAY-1545: Channex options and delivery
   (after VAY-1541, VAY-1542, VAY-1527 and VAY-1528).
9. VAY-1546: deployed saved-configuration verification
   (after VAY-1543, VAY-1544 and VAY-1545).

Keep PRs narrow (about 400 meaningful changed lines); split a slice further
before implementation if needed. VAY-1527 supplies date resolution and durable
automatic delivery; reuse its completed stack rather than rebuilding it.
Coordinate direct-quote work with VAY-910 and meal compatibility with VAY-1530.

Checks must include the table above; duplicate/missing counts; capacity and
policy changes; negative results from a low date price; currency/revision
conflicts; standard/season/weekend/year boundaries; different room allocations;
non-refundable rounding; date removal; stale quotes; historical bookings;
tenant/role denials; durable retries; HTTP-200 provider warnings; and safe
activation failure. Automated payload tests are not provider readback, and
provider readback is not downstream OTA delivery. Record each separately.
No real reservations, payments or guest messages belong in validation.
