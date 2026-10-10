# Channex ownership per hotel

VAY-2108. Contract for running Channex in the target one hotel at a time, while legacy keeps
running Channex for every other hotel (VAY-1362 phased waves, runbook #3042).

## The gate

The target owns a hotel's Channex property only when **all** of these hold:

- an active `pms.channel_binding_claims` row for the property;
- a `pms.channel_connections` row that is `connected` on the **same** external id (booking writes
  and feed pulls require `connected`; a `degraded` connection keeps its receipts but is not pulled);
- outside staging Channex, neither id is one of the staging/test ids reserved by migration 0432
  (`CHANNEX_RESERVED_TEST_IDS`).

Every Channex path that writes or pulls for a hotel checks the gate. Webhook routing only
attributes events, so it follows the active claim alone: a claimed hotel whose connection is
briefly degraded or disconnected keeps its receipts, and the jobs re-check the connection. The claimed scope (rollout
below) adds a production next-api env allowlist on top, so a hotel also has to be named there.
The global capability modes stay as kill switches; they never select hotels.

| Path                                                                     | Where                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Webhook routing (booking, message, alert, alteration), active claim only | `platform/providerWebhooks.ts` `resolveChannexPropertyId`                             |
| Booking persistence (webhook hint and pulled revisions)                  | `jobs/channexBookings.ts` `persist`                                                   |
| Daily full ARI producer                                                  | `jobs/pmsChannexManagementWorkerStore.ts` `claim`                                     |
| Management plans (sync_bookings, ARI, provisioning)                      | `integrations/channexManagementPlans.ts` `activeExternalPropertyId` (already refuses) |

Known exceptions, outside the gate until a later slice: review ingestion resolves a property by
its external id alone (`jobs/channexReviews.ts`), and message persistence checks only the
connection (`jobs/channexMessages.ts`). Neither creates bookings, inventory or ARI. Under the
claimed scope, messaging stays `observe_only`.

Trigger 0128 creates an **active** `migration` claim whenever a connection with a `vay1351-*`
`migrationRunId` gets an external id while it has no claim. So imported cohort hotels arrive
handover-pending: no claim row, connection `disconnected`, external id `NULL`, the legacy id in
`connection_metadata.legacyExternalPropertyId`. Nothing but the handover executor may set their
external id.

## Handover (H.2) and revoke

An audited executor, run through a reviewed platform runner mode with Flamur's go:

- `target:channex:handover activate`, in one transaction: cohort membership and the legacy-disable readback (F.7)
  are recorded; the legacy id is unique, not reserved and not claimed elsewhere; then the claim
  is inserted as active with `claim_source = 'handover'` (or a released handover claim is
  reactivated) **before** the connection gets the external id and turns `connected`. Inserting
  the claim first is what keeps trigger 0128 from writing its own claim.
- `target:channex:handover revoke` is the inverse, also in one transaction: the connection goes back to `disconnected`
  with a `NULL` external id, then the claim becomes `released`. Both commands write an audit row.
- Never the `disable` command: it deletes the Channex property. Never `enable` either.

## Booking intake

Legacy pulls the booking-revision feed for every active connection every 5 minutes and
acknowledges every revision it sees. An acknowledgement removes the revision from the shared
feed. So the target starts pulling a hotel only after legacy's local disable for that hotel,
which is why the executor requires the F.7 readback. Wave 1 is pull-only: a scheduled pull
every 5 minutes for each gated hotel, on the API runtime login. The property-scoped booking
webhook (runbook P17) comes later. Before it does, `CHANNEX_WEBHOOK_INTAKE_MODE` stays
`observe_only`: in `mutating` mode, a claimed hotel whose connection is down would get booking
and message jobs that retry and then dead-letter.

## Rollout

1. Gate and executor ship inert. Production next-api keeps booking sync, ARI and provisioning
   `observe_only`.
2. Booking path: next-api `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned` and
   `PMS_CHANNEX_BOOKING_SYNC_MODE=mutating`. `CHANNEX_WEBHOOK_INTAKE_MODE` stays `observe_only`.
   This setting exists only on next-api. The legacy variable of the same name freezes legacy
   polling for every hotel and is never set during a wave.
3. Per hotel: legacy disable and readback, then `activate`, then the first pull within minutes.
4. ARI and published offers: a claimed worker scope (new RLS helper, the pinned scope functions
   untouched, digests re-pinned) plus platform grant/preflight. Then the initial offer ARI with
   `stop_sell=true`, and activation at a quiet time.

Kill switches: modes back to `observe_only` stop every hotel; `revoke` stops one.
