# Channex meal synchronization (VAY-1530)

Consumes [VAY-1529's canonical meal contract](pms-meal-inclusive-rate-plan-contract.md)
and extends [durable Channex management](pms-channex-management-contract.md).
`room_only` and `breakfast` map directly to documented Channex `meal_type` values.
Canonical historical NULL defaults to room only; noncanonical/adopted NULL remains
unknown and is omitted, including when an existing provider plan is discovered.
Unsupported explicit local values fail before provider writes.

Provisioning preserves plan IDs and mappings. Existing plans use a meal-only PUT,
after property/room/rate identity readback, followed by meal readback. Unchanged
meals are no-ops. Retries reread canonical state. Canonical saves atomically enqueue
a rate-scoped provisioning job only when provisioning capability is mutating and
the property has a connected/degraded Channex connection. Worker claims serialize
per property across instances. No price component or breakfast surcharge is added;
existing ARI pricing and channel adjustments remain authoritative.

| Destination           | Supported path                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unmapped Channex rate | In-place meal-only PUT and GET readback; never delete/recreate.                                                                                                                                                                                                                                      |
| Booking.com           | Unchanged Channex meal is a no-op. A changed meal on an OTA-mapped plan fails visibly; the documented channel API supplies ARI and maps existing OTA rates, but supplies no meal-content update. OTA-side meal terms and mapping require verification before a supported change path can be enabled. |
| Other OTA mappings    | Changed meals fail visibly until that channel's content contract is verified. No automatic remapping or room-only fallback.                                                                                                                                                                          |

Failure uses existing operation/dead-letter and mapping-sync status. Updating a
Channex rate's metadata is not evidence of OTA presentation. Controlled remapping
is not implemented without an authoritative OTA meal contract and test connection.

Provider references checked 2026-09-07:
[Rate plans](https://docs.channex.io/api-v.1-documentation/rate-plans-collection),
[Booking.com channel API](https://docs.channex.io/channel-api-examples/booking.com).
Local PostgreSQL and mocked HTTP validation do not establish live provider delivery.

## Isolated TypeScript staging delivery

After the restrictions staging deployment and binding are verified, opt in with
`PMS_CHANNEX_STAGING_MEALS_ENABLED=true` and provisioning mode `mutating`.
This requires the existing staging restriction property scope, exact staging URL,
ARI mutating, and all global background workers disabled. Other capability modes
remain observe-only. Default restrictions-only behavior is unchanged.

The scoped worker additionally claims only `provision` jobs with a valid
`mealRatePlanId` for that property; full provisioning and all other operations
remain unclaimed. Canonical meal-save enqueue is scoped to the same property.
Staging meal plans update only established mappings and never provision missing
room/rate variants; a plan without any mapped rate fails visibly. Normal production
provisioning behavior is unchanged. Reuse the audited sandbox binding. Coordinate deployment
and fixture ownership with VAY-1528 before opting in; use no live OTA mappings.
