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
- `target:channex:handover attach` is the takeover for a hotel that was **not** imported: a fresh
  target property (normal onboarding) takes over the Channex property the old system ran. It
  takes the Channex id, the legacy-disable readback and a reviewed manifest (the Channex room
  type per target room type, the Channex rate plans to adopt under each, the capabilities). In
  one transaction it inserts the `handover` claim, connects the connection (inserting one when
  the hotel never pressed "Enable connection"), writes the room-type mappings, one
  `pms.rate_plans` row (`CH-<id prefix>`) plus its mapping per adopted Channex rate plan, and
  queues the booking copy below. It refuses when another target property holds the Channex id
  in any claim state, when the property already has an external id, and when an active room
  type is neither mapped nor named as deliberately unmapped. The adopted rate plans are what
  booking intake needs: every OTA booking references the rate plans the old system created in
  Channex. The rate-owner registry (0314) allows one owner per Channex rate plan, a legacy
  mapping or an offer target, so the adopted plans stay legacy mappings for booking intake
  only (decided 2026-10-27). Our published offers create **new** Channex rate plans under the
  same rooms; on switch day the Booking.com and Airbnb rate mapping inside Channex moves from
  the old plans to the new ones before full ARI goes out. The old Channex rate plans stay:
  never delete them, bookings made under them keep arriving through the adopted mappings.
- `target:channex:handover revoke` is the inverse of both, also in one transaction: the connection goes back to `disconnected`
  with a `NULL` external id, mappings are disabled, then the claim becomes `released`. A second
  `attach` reuses the retained rows. Every command writes an audit row; re-running an applied
  plan reports `replayed=true`.
- Never the `disable` command: it deletes the Channex property. Never `enable` either.

### The booking copy on switch day

Legacy acknowledged every revision of the hotel, so the feed shows none of its existing
bookings. The attach apply queues one `channex.resync-bookings` job for the binding. The
claimed feed-pull loop runs it on the API login: it lists the hotel's bookings with a
departure from yesterday (UTC) on, fetches each booking's latest revision and queues it exactly
like a pulled revision; the booking worker persists it through the same room and rate mapping
and the same inventory lock. The ingest job's own acknowledgement answers 404 for those
revisions and counts as done. A failed booking spends one of the job's three attempts (five
minutes apart); Channex rate limiting or a worker shutdown gives the attempt back; a binding
that changed since the attach, or a hotel with more than 2,000 upcoming bookings, fails the
job at once and needs its own plan. A crashed run gets its next attempt after two hours. Only
the production worker takes the job (the payload carries no host until the claim stamps it).
The list starts two UTC days back, so stays that departed yesterday in any hotel timezone are
copied too and show as past stays. A run that exceeds its eight-minute budget pauses with the
ids it queued and the next run continues from there. Full ARI must
wait until the resync job succeeded (`job_metadata.bookings` = `promoted`), or the rooms look
free. Direct bookings from the old booking engine are
re-entered as manual bookings in the new PMS (they block the units the same way).

## Booking intake

Legacy pulls the booking-revision feed for every active connection every 5 minutes and
acknowledges every revision it sees. An acknowledgement removes the revision from the shared
feed. So the target starts pulling a hotel only after legacy's local disable for that hotel,
which is why the executor requires the F.7 readback. Wave 1 is pull-only: a scheduled pull
every 5 minutes for each gated hotel, on the API runtime login. The property-scoped booking
webhook (runbook P17) comes later. Before it does, `CHANNEX_WEBHOOK_INTAKE_MODE` stays
`observe_only`: in `mutating` mode, a claimed hotel whose connection is down would get booking
and message jobs that retry and then dead-letter.

### When intake refuses a booking

The OTA has already confirmed the booking, so a refusal must never be silent (VAY-2108 W1d):

- Every dead-lettered ingest job writes a `booking_not_imported` alert in the same transaction
  (PMS → Channel manager → Channel alerts), with the OTA, its reservation code, the stay, the
  Channex room and rate ids and the reason. The worker logs each one with the property id and
  reason. "Retry import" re-ingests the revision once the cause is fixed. An applied later
  revision of the same booking, or its cancellation, closes the alert.
- A refused revision is **not** acknowledged, so Channex keeps flagging it too. Both feed readers
  (the scheduled pull and the webhook-hint load) page through the whole feed, at most 20 pages of
  100 per run; a longer feed is logged with the hotel. Refused revisions never hide newer ones.
- A booking on `closed` or `linked_stop_sell` nights is saved (VAY-1981 refused it): its rooms get
  `inventoryWarning` in the assignment payload, and the hotel gets a `booking_on_closed_night`
  alert to check it can host the guest. The switch-day booking copy uses the same path.
- Still refused, now with the alert: more rooms than physically exist, nights beyond the open
  calendar (no inventory day yet), unmapped rooms or rates, and a stay change on a room the host
  chose by hand (VAY-2385).

## Rollout

1. Gate and executor ship inert. Production next-api keeps booking sync, ARI and provisioning
   `observe_only`.
2. Booking path: next-api `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned` and
   `PMS_CHANNEX_BOOKING_SYNC_MODE=mutating`. `CHANNEX_WEBHOOK_INTAKE_MODE` stays `observe_only`.
   This setting exists only on next-api. The legacy variable of the same name freezes legacy
   polling for every hotel and is never set during a wave.
3. Per hotel: legacy disable and readback, then `attach` (or `activate` for an imported row),
   then the booking copy and the first pull within minutes. Then the offers create their rate
   plans, the OTA rate mapping in Channex moves to them, and only then full ARI.
   - **Before attach, check the hotel's calendar**, so its OTA bookings land without warnings:
     the operating calendar is year-round, or its seasons match what the OTAs sell; calendar
     auto-open is On (rolling 12 months); no mapped room type is retired; room types share a
     linked inventory group only if the OTAs sell them the same way; and a read-only count shows
     0 `closed` and 0 `linked_stop_sell` inventory days for every mapped room type over the open
     calendar, including the nights of the bookings the copy brings in.
   - **Before full ARI, make sure Booking.com and Airbnb cannot sell beyond our open calendar.**
     Legacy's last push may reach further than our 12 months: read the hotel's furthest open
     night in Channex, and if it lies past our last inventory day, close those nights in Channex
     (a Channex write, so Flamur's go). A booking there is refused, with the alert.
4. ARI and published offers (D7): `PMS_CHANNEX_ARI_SYNC_MODE` and `PMS_CHANNEX_PROVISIONING_MODE`
   turn `mutating` together under the claimed scope, on top of booking sync. The worker then runs
   under the claimed DB scope (0519: new RLS helper, the pinned scope functions untouched, digests
   re-pinned) after the platform's claimed grant and preflight. It claims `sync_ari` and
   `provision` jobs only for the owned hotels that pass the gate, plus unbound `enable` jobs.
   Creating the missing Channex room types of a hotel that pressed "Enable connection" is the
   D7b follow-up: the worker login may lock but not insert `pms.channel_room_type_mappings`, so
   it needs a migration (restrictive insert policy on the claimed gate) and a platform grant
   first; a taken-over hotel adopts its existing rooms through the attach step and needs none of
   that. Rate plans come only from published offers, which the owned hotels may provision through
   the published-offer route. The
   ARI schedule enqueues a full sync for each owned, claimed hotel whenever its pricing, rooms,
   mappings, inventory or closures change, or the local date moves. Then the initial offer ARI
   with `stop_sell=true`, activation, and ongoing delivery
   (`engineering/channex-ongoing-offer-ari.md`) once `PMS_CHANNEX_OFFER_ARI_DELIVERY_ENABLED` is on.

Kill switches: modes back to `observe_only` stop every hotel; `revoke` stops one.
