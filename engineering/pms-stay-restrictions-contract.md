# PMS stay restriction synchronization

VAY-1528 extends [PMS Channex management](pms-channex-management-contract.md).

The existing TypeScript reservation checks in `pmsRoomSelectionConflicts.ts`,
`pmsInventoryReservation.ts`, and `bookingWebPublic.ts` evaluate minimum and
maximum stays on the **arrival date**. Seasonal snapshots are stored per date,
but booking queries explicitly filter stay limits to check-in. Therefore send
`min_stay_arrival`, and always reset `min_stay_through` to 1. Do not use Channex's
property-dependent virtual `min_stay` field. Set property `settings.min_stay_type`
to `arrival` on enable and ARI sync, as the [property API](https://docs.channex.io/api-v.1-documentation/hotels-collection)
uses this to select minimum-stay values for channel mappings. Verify existing
channel settings in deployed acceptance; Airbnb, for example, accepts only one
minimum-stay type.

Canonical sources are `pms.rate_rules` for the property and room, with a null
rate-plan ID applying to every plan and a non-null ID applying only to that plan.
Room defaults, seasonal and date-specific rules combine as existing reservation
guards do: highest minimum, lowest non-null maximum, OR of closure flags. There
is no implicit date-specific override of a stricter seasonal rule. Ranges include
both endpoints and PostgreSQL weekdays run Sunday=0 through Saturday=6.
If no applicable rule supplies a minimum, use the latest operating-calendar
`default_minimum_stay_nights`, then 1. Disabled rules contribute nothing. Null limits contribute nothing; defaults are
minimum=1, unlimited maximum, and false closure/stop-sell flags. Conflicting
effective limits are invalid and must fail before any provider request.

The new `stop_sell` flag is an explicit rate-plan restriction, independent of
room availability, linked-inventory closures and same-day cutoffs. Arrival and
departure closures apply only to their respective boundary dates; a Sunday
arrival closure must permit an otherwise eligible Saturday–Monday stay.

Every ARI attempt reads current rules and sends all fields on every inventory
date from property-local today across all persisted future inventory dates. Removing,
shortening or disabling a rule thus sends fallback values on its old dates.
All new automatic jobs and rule-edit commands send restriction fields only, preserving existing prices and
availability. Full/manual inventory synchronization retains its ARI behavior.
Provider resets are minimum arrival=1, minimum through=1, maximum=0, and false
booleans. Historical job payloads must never reapply configuration on retry.

Provider contract checked 2026-09-07: [ARI](https://docs.channex.io/api-v.1-documentation/ari)
accepts positive minimums, non-negative maximums and boolean closures. The
[open-channel contract](https://docs.channex.io/for-ota/open-channel-api) explicitly
defines maximum 0 as unrestricted. Null or
omitted fields do not clear restrictions. A response carrying ARI warnings is
a failure even when HTTP status is successful. Provider acceptance is distinct
from connected OTA enforcement; deployed evidence must name the tested channel,
record unavailable capabilities, and restore bounded synthetic configuration.

## Configuration and delivery

**Retired (VAY-2208, 2026-10-15).** Restriction-only ARI has had no sender since
the old pricing was removed (#1764): every restriction-only `sync_ari` job ends in
`PRICING_UNAVAILABLE`. The `GET`/`PUT /api/pms/properties/:propertyId/channex/stay-restrictions`
route, its command input and the worker's daily restriction refresh are removed.
Migration 0489 drops the `pms.rate_rules` and operating-calendar triggers that
queued restriction-only jobs; `pms.enqueue_restriction_ari` stays because the
platform runtime preflight and grant scripts still require it. Booking quotes keep
enforcing `pms.rate_rules` (imported rules) through `pms.effective_stay_restrictions`.

Hotels now edit stay rules in pricing-v2 (room Prices › Stay rules/dates). The
published-offer Channex path sends those values only on closed initial uploads
(`stop_sell` forced true) and has no post-activation restriction delivery yet;
that is tracked separately, not here.

## Isolated deployed staging verification (VAY-1528)

The shared canary keeps API_BACKGROUND_WORKERS_ENABLED=false. A separate
PMS_CHANNEX_STAGING_RESTRICTIONS_PROPERTY_ID enables only the Channex management
loop for that property. Startup requires the exact staging provider URL, a UUID,
and ARI as the only mutating capability. Both daily restriction refresh and job
claim are scoped (the daily refresh was removed in VAY-2208); claims accept only
sync_ari with restrictionsOnly=true. Full
ARI, provisioning, connection lifecycle, booking, and message jobs remain untouched.
The existing property-scoped sandbox key is injected by ECS. Bind and map the
existing sandbox through an audited, bounded fixture repair before testing; do
not use Enable to create another provider property. All other workers and the
global ARI scheduler stay disabled. Default production behavior is unchanged.
