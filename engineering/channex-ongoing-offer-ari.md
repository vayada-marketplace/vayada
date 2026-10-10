# Ongoing Channex offer ARI

VAY-2108. Contract for keeping a published offer's Channex rate plan current after activation, and
for opening and closing its sales. Today the replacement pipeline sends one closed initial ARI per
rate plan and date, activates internally, and never sends `stop_sell: false` or later changes. This
contract adds ongoing delivery for hotels the target owns (engineering/channex-per-hotel-ownership.md).

## Desired versus last sent

The unit is a key plus a date: `(binding_generation, external_property_id, external_rate_plan_id,
service_date)`. A new binding generation never compares against the old binding's values.

- **Desired** (pricing, `readChannexOfferDesiredAri`): one Channex `values[]` entry per date in the
  window hotel-local today through `DEFAULT_FULL_ARI_DAYS_AHEAD`. It holds `rates` sorted by
  occupancy, `min_stay_arrival`, `min_stay_through`, `max_stay`, `closed_to_arrival`,
  `closed_to_departure` and `stop_sell`, plus `valueSha256` over canonical sorted-key JSON. A single
  builder (`buildChannexOfferAriValue`) produces both initial and ongoing values.
- **Last sent:** the latest _reconciled_ delivery that contains the date. If there is none, it is
  the initial ARI attempt's `request_body.values[0]`, hashed with the same builder.
- A date is sent when the desired sha differs from the last-sent sha. Dates entering the horizon
  have no last-sent value and are sent.

## Sales state

`pms.channex_offer_targets.sales_state` is `closed` (the default, also right after activation) or
`open`. Desired `stop_sell` = the rules' stop-sell **or** `sales_state <> 'open'`, so there is no
other stop-sell path. The state changes only through the audited `target:channex:handover
open-sales|close-sales` commands, which run through the reviewed platform runner and touch the
database only. Opening re-sends every date once, because the initial values carry `stop_sell: true`.

## Delivery

The worker sends from a full `channex.sync_ari` job, after activation, for owned hotels only:

- It collapses consecutive dates whose value (without the date) is identical into `date_from` and
  `date_to` entries, with at most 100 entries per `POST /api/v1/restrictions`.
- Each POST is one `pms.channex_offer_ari_deliveries` row, with at most one unresolved per target.
  Its identity (version, binding, provider ids) is copied by trigger from the target's active
  version, never taken from the caller.
- The per-date values and shas are in `pms.channex_offer_ari_delivery_dates`, and the provider
  response is in `pms.channex_offer_ari_delivery_receipts`.
- Reconciliation follows the initial ARI: Channex task readback, then `reconciled`. A failed
  delivery is `released` and its dates are sent again.

A publication bump on an active target whose provider configuration is unchanged keeps the target
current, and the next delivery pushes the difference. A changed configuration is reported as
`active_offer_configuration_changed`: the target is skipped and an operational alert is raised.

## Ownership

| Part                                                                         | Owner            |
| ---------------------------------------------------------------------------- | ---------------- |
| Schema (0481), delivery, reconciliation, open/close commands, claimed wiring | VAY-2108         |
| Desired values, shared builder, publication bumps                            | VAY-1543 pricing |
