# Ongoing Channex offer ARI

VAY-2108. Contract for keeping a published offer's Channex rate plan current after activation, and
for opening and closing its sales. Today the replacement pipeline sends one closed initial ARI per
rate plan and date, activates internally, and never sends `stop_sell: false` or later changes. This
contract adds ongoing delivery for hotels the target owns (the per-hotel ownership contract,
`engineering/channex-per-hotel-ownership.md`, VAY-2108 #3075).

## Desired versus last sent

The unit is a key plus a date: `(binding_generation, external_property_id, external_rate_plan_id,
service_date)`. A new binding generation never compares against the old binding's values.

- **Desired** (pricing, `readChannexOfferDesiredAri`): one Channex `values[]` entry per date in the
  window hotel-local today through `DEFAULT_FULL_ARI_DAYS_AHEAD`. It holds `rates` sorted by
  occupancy, `min_stay_arrival`, `min_stay_through`, `max_stay`, `closed_to_arrival`,
  `closed_to_departure` and `stop_sell`, plus `valueSha256` over the canonical sorted-key JSON of the
  whole entry (provider ids and date included). A single builder (`buildChannexOfferAriValue`)
  produces both initial and ongoing values. An unpriced night is restriction-only (`stop_sell: true`,
  no rates) and is never merged with priced nights.
- **Last sent:** the most recent _reconciled_ write for the full key, across both the initial ARI
  attempts (`request_body.values[0]`, hashed with the same builder) and the ongoing deliveries
  (`channex_offer_ari_delivery_dates`), ordered by when the write was made.
- A date is sent when the desired sha differs from the last-sent sha. Dates entering the horizon
  have no last-sent value and are sent.

## Sales state

`pms.channex_offer_targets.sales_state` is `closed` (the default, also right after activation) or
`open`. Desired `stop_sell` = the rules' stop-sell **or** `sales_state <> 'open'`, so there is no
other stop-sell path. The state changes only through the audited `target:channex:handover
open-sales|close-sales` commands, which run through the reviewed platform runner and touch the
database only. Opening re-sends every date once, because the initial values carry `stop_sell: true`.
A revoke closes every open target in its own transaction and records them in its audit. It cannot
reach Channex afterwards, because the worker no longer serves the hotel: to stop sales on Channex
before a revoke, run close-sales and wait for its delivery to reconcile first. A reviewed plan applies
once; re-running it reports the recorded result unless a later handover command ran since
(`plan_superseded`) or the inputs differ (`replay_mismatch`).
An open state always has `sales_state_changed_at`. Moving `active_version` (a new version or binding)
resets the state to `closed`, so a new provider configuration never opens without a new command. That
reset is a trigger in the delivery PR's migration (it changes the worker's pinned trigger catalog, so it
lands with that boundary re-pin), and it must be live before any delivery is sent; until then nothing
reads `sales_state`.
The database does not stop the API login from writing the column; no API code does. On the delivery
tables 0481 leaves the API login only SELECT (a guarded revoke of the VAY-2054 default writes); the
platform's protected-table pattern for them ships first, so its product-DML preflight expects that.

## Delivery

The worker sends from a full `channex.sync_ari` job, after activation, for owned hotels only:

- It collapses consecutive dates whose value (without the date) is identical into `date_from` and
  `date_to` entries, with at most 100 entries per `POST /api/v1/restrictions`.
- Each POST is one `pms.channex_offer_ari_deliveries` row, with at most one unresolved per target.
  Its identity (version, binding, provider ids) is copied by trigger from the target's active
  version, never taken from the caller.
- The per-date values and shas are in `pms.channex_offer_ari_delivery_dates`, and the provider
  response is in `pms.channex_offer_ari_delivery_receipts`.
- Reconciliation follows the initial ARI: Channex task readback, then `reconciled`. `released`
  means provably not sent (no provider receipt; the database refuses releasing a delivery that has
  one). An answered delivery whose outcome is unclear stays unresolved until a value readback settles
  it; meanwhile it blocks only its own target. A delivery never runs while that target's initial ARI
  is unresolved, and needs the current lease of a running full `channex.sync_ari` job on the
  connected binding.

A publication bump on an active target whose provider configuration is unchanged keeps the target
current, and the next delivery pushes the difference. A changed configuration is reported as
`active_offer_configuration_changed`: the target is skipped and an operational alert is raised.

## Ownership

| Part                                                                         | Owner            |
| ---------------------------------------------------------------------------- | ---------------- |
| Schema (0481), delivery, reconciliation, open/close commands, claimed wiring | VAY-2108         |
| Desired values, shared builder, publication bumps                            | VAY-1543 pricing |
