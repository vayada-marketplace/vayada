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
An open state always has `sales_state_changed_at`. Moving `active_version` (a new version or binding)
resets the state to `closed` (trigger from 0521), so a new provider configuration never opens
without a new command.
The database does not stop the API login from writing the column; no API code does. On the delivery
tables 0520 leaves the API login only SELECT (a guarded revoke of the VAY-2054 default writes); the
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
- Reconciliation runs before any new delivery and settles every unresolved delivery of the hotel:
  - an accepted receipt (200, no warnings, task ids) is verified by Channex task readback, where
    each task's payload must equal the posted body: `reconciled`, `completionBasis`
    `finished_task_fifo`. Only such deliveries count as "last sent";
  - a transport error, a non-200 answer or an unclear body closes the delivery as `reconciled` with
    `completionBasis` `unverified` (a 4xx answer other than 408/425/429: `provider_rejected`). Its
    dates never count as sent, so the next run sends them again, which is safe because ARI writes
    are idempotent. A transport error or a 5xx also fails the worker turn (`provider_unavailable`),
    so the resend follows the job's backoff and attempt ceiling. A rejected body is not retried
    while the desired body is unchanged (`requestSha256`); the target is skipped and reported
    instead;
  - a delivery without any receipt whose job attempt has ended was never answered as far as the
    database knows and is `released` (the database refuses releasing a delivery that has a
    receipt). A POST that was in flight when the lease moved may still have reached Channex; the
    resend is idempotent, so that costs one duplicate write. The next run claims afresh.
  - A task that Channex reports as failed keeps its delivery unresolved and the target blocked
    until an operator settles it (follow-up: an audited settle command).
  A delivery never runs while that target's initial ARI or an earlier delivery is unresolved, and
  needs the current lease of a running full `channex.sync_ari` job on the connected binding. Right
  before the POST the claim is re-verified under fresh authority (same active version, binding,
  connected connection, no receipt); otherwise it is released unsent.
- Per-target outcomes of one run: a target whose configuration or binding changed is skipped and
  listed in the job result (`skippedOfferTargets`), which the worker records as a degraded ARI sync
  status (`offer_targets_skipped`) on the channel manager page. Activation (D5) reports such a
  target for the hotel; with the delivery switch on the run still delivers the other targets,
  without it the sync fails until the offer is reconfigured. Only a full `channex.sync_ari` job
  delivers; a provisioning job ends at activation. Opening sales reaches Channex with the next
  scheduled full sync. A target whose offer left the
  publication is closed: every night of its rate plan gets `stop_sell: true` without touching
  `sales_state`, so a vanished offer never keeps selling.
- Rollout: the delivery path is behind `PMS_CHANNEX_OFFER_ARI_DELIVERY_ENABLED` (default off, needs
  a mutating ARI sync). The worker's privilege matrix lists the three delivery tables; while the
  switch is off, the boundary tolerates them ungranted and without row security, so the image ships
  before migration D3a (0521: worker policies through the target and the delivery, the sales reset
  trigger) and before the platform's delivery grant mode. With the switch on, the boundary requires
  both.

A publication bump on an active target whose provider configuration is unchanged keeps the target
current, and the next delivery pushes the difference. A changed configuration is reported as
`active_offer_configuration_changed`: the target is skipped and an operational alert is raised.

## Ownership

| Part                                                                         | Owner            |
| ---------------------------------------------------------------------------- | ---------------- |
| Schema (0520), delivery, reconciliation, open/close commands, claimed wiring | VAY-2108         |
| Desired values, shared builder, publication bumps                            | VAY-1543 pricing |
