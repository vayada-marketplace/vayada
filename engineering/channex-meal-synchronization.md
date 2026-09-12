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

## Replacement meal readback handoff

The VAY-1530 helper accepts the five `PricingMeal.kind` values directly: room only,
breakfast, half board, full board and all inclusive. These exact API values are
listed in the Channex rate-plan documentation (rechecked 2026-09-12). No `none`,
missing value or alternate breakfast label is inferred to equal a configured meal.

`verifyChannexMealReadback(externalPropertyId, meal, request)` is read-only. It
returns `{ externalPropertyId, externalRoomTypeId, externalRatePlanId, mealType }`
only after exact provider identity and inclusion checks, rejecting conflicting
attribute/relationship identities. Existing reconciliation shares this identity
reader and retains its OTA-mapped-change guard and `Promise<void>` interface.

The target writer owned by VAY-1545 must associate this observation with its exact
logical offer, pending version, binding generation and current publication, and
recheck freshness before activation. This helper does not establish those facts,
verify inclusive amounts, authorize activation or prove OTA meal presentation.
It does not wire replacement saves to live jobs. Target storage and the writer
remain separate prerequisites; no legacy rate-plan rows are recreated here.
