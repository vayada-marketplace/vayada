# PMS stay restriction synchronization

VAY-1528 extends [PMS Channex management](pms-channex-management-contract.md).

The existing TypeScript reservation checks in `pmsRoomSelectionConflicts.ts`,
`pmsInventoryReservation.ts`, and `bookingWebPublic.ts` evaluate minimum and
maximum stays on the **arrival date**. Seasonal snapshots are stored per date,
but booking queries explicitly filter stay limits to check-in. Therefore send
`min_stay_arrival`, and always reset `min_stay_through` to 1. Do not use Channex's
property-dependent virtual `min_stay` field.

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

`GET /api/pms/properties/:propertyId/channex/stay-restrictions` lists canonical
rules. `PUT` accepts `{commandId, idempotencyKey, restrictions: {roomTypeId,
ratePlanId, rules}}`. Each rule supplies `startsOn`, `endsOn`, `daysOfWeek`,
nullable `minStayNights`/`maxStayNights`, and boolean `closedToArrival`,
`closedToDeparture`, `stopSell`, `enabled`. This replaces the scoped
`stay_restriction` rows; an empty list deletes them. Seasonal and other rule
sources remain owned by their current configuration flows. Ranges are at most
731 days and the command accepts at most 100 rules. Scope and overlap validation,
idempotency reservation, rule persistence, audit and queueing commit atomically.

Rule changes and inventory ARI outbox events enqueue snapshot-free management
jobs in the same transaction. Multiple row edits coalesce by property and
transaction. The management worker also schedules one full restriction sync per property-local
day, retains existing failure/dead-letter reporting and excludes ARI work when
`ariSync` is observe-only. Same-property management jobs are serialized. Manual
sync, automatic sync and retries all use the same current-state planner.
