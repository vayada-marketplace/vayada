# Legacy → TypeScript migration runbook: phased waves (VAY-1362)

_Draft v2, 2026-10-10. Rewritten for a phased migration in waves (Flamur,
2026-10-10); v1 assumed one global cutover. Not yet rehearsed. Sequences the
existing tooling in
[`packages/backend-migration`](../packages/backend-migration/README.md),
[`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md),
[`legacy-historical-binding-preflight.md`](legacy-historical-binding-preflight.md),
the billing note `legacy-fixed-plan-billing-handover.md` (billing stack, #2979)
and the pricing design `legacy-pricing-to-v2-mapping.md` (VAY-2086, #3024).
Every duration is an estimate until a rehearsal measures it. Nothing in this
document is an approval: each **[GO]** step needs an explicit human go on the
day._

## Terms

- **Wave:** one production cutover run (one source run, one cohort). Its
  **wave hotels** are that run's cohort.
- **Migrated hotel:** a hotel whose wave has run. From its freeze on, legacy
  must not write for it or act on its provider events (wave 1: except the
  accepted residual risks).
- **Legacy-only hotel:** every other legacy hotel. It keeps trading on legacy,
  unchanged, until its own wave or until legacy retirement.
- The cohort contract ([`legacy-migration-cohort-scope.md`](legacy-migration-cohort-scope.md))
  applies per wave. Each run has three classes of hotel: its **cohort** (the
  wave hotels); **earlier waves' hotels**, which the run must leave untouched
  (W2.2); and **non-cohort** hotels, which import as private, without access
  and inert in the target.

## Decisions

| Topic                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phased migration             | (2026-10-10) Hotels move in waves. A hotel moves only once it can take v2 bookings as it does today. Legacy keeps running for legacy-only hotels; there is **no global legacy freeze** any more.                                                                                                                                                                                                                                                                                                                                                                                       |
| Waves                        | Wave 1: Aether B, Dolcemare, Haigha House. Later waves: the other five initial candidates, then the 23 other recently active legacy PMS hotels (decided, deferred). See [Waves](#waves).                                                                                                                                                                                                                                                                                                                                                                                               |
| Scope per run                | Cohort-scoped import (2026-10-08). Only the wave's hotels become live target properties. The cohort manifest is reviewed outside the repo.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Native lookalikes            | Native Owner properties with similar names are separate businesses; there is no reuse mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Owner access                 | PMS-only access to the owner's own migrated hotels, no email matching, no automatic Marketplace approval (VAY-2017).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Legacy freeze, wave 1        | (2026-10-10) **Operational per-hotel freeze**, with no legacy code change and no legacy deploy: a platform ALB rule (`410` on the hotels' legacy booking API routes; booking pages and custom domains redirected to v2), pending requests resolved and payouts settled before the snapshot, legacy's local Channex disable right after the snapshot (Aether B), and owner logins suspended after the import where the owner has no other legacy hotel. Flamur accepts the residual risks on go-day (see [Wave-1 residual risks](#wave-1-residual-risks-accepted-by-flamur-on-go-day)). |
| Legacy freeze, wave 2 onward | The **full legacy per-hotel guard** (`is_migrated(hotel)`, planned, not built) is a wave-2 prerequisite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Legacy deploys               | (2026-10-10) The legacy deploy workflows stay **disabled**. Each legacy change goes live by an explicit `workflow_dispatch` of the platform `deploy.yml` with an image digest and Flamur's go per deploy. Auto-deploy is not re-enabled.                                                                                                                                                                                                                                                                                                                                               |
| OTA closure at handover      | (2026-10-10) Accepted: the first v2 ARI push for a hotel is `stop_sell=true`, and its OTAs reopen at the later activation step. Schedule each hotel's handover at a quiet time for that hotel.                                                                                                                                                                                                                                                                                                                                                                                         |
| Payouts in flight            | (2026-10-10) Legacy finishes the payouts it already started for a migrated hotel; the wave-2 guard exempts them. Wave 1: the wave hotels' open legacy payouts (scheduled, processing, failed) are settled or voided before the snapshot.                                                                                                                                                                                                                                                                                                                                               |
| Fixed-plan Stripe billing    | No global billing freeze; legacy stays in `FIXED_PLAN_BILLING_MODE=legacy`. **Wave 1 adopts nothing:** a wave-1 hotel's fixed-plan subscription (if any) stays on legacy until wave 2, which avoids a legacy deploy and double charging. From wave 2, legacy skips adopted subscriptions by their adoption marker (#2980) and only the wave hotels' subscriptions are adopted. Legacy-only hotels' subscriptions keep running on legacy; nothing is cancelled because a hotel is outside a wave. This replaces the T-7 freeze in the billing note.                                     |
| Pricing                      | VAY-2086: each wave hotel's legacy prices are converted to pricing-v2 and published before its reopen; payment terms copy the legacy setting; online card stays online card. A hotel that fails its pricing gate is suspended on its own.                                                                                                                                                                                                                                                                                                                                              |
| Rollback                     | 0-day window, per wave. Before a hotel's handover it can go back to legacy (R1). After its reopen, fix forward only: legacy is not a fallback for a migrated hotel, even though legacy keeps running for others.                                                                                                                                                                                                                                                                                                                                                                       |

## Waves

| Wave               | Hotel (legacy ID prefix)                   | Currency   | Legacy payment and mode                                                | Needs before its wave                                                                                                                                                                                |
| ------------------ | ------------------------------------------ | ---------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                  | Aether Hilltop Villas B `29f39aae`         | USD        | Card on its own onboarded Stripe Connect account; instant              | Card prerequisites (P10); VAY-2100 PR2 (P9); native Channex markup, 10% on one channel (P13), checked by G5. The only wave-1 hotel with a Channex handover                                           |
| 1                  | Dolcemare `7d3f6dcc`                       | IDR        | Pay at property; request mode (kept)                                   | VAY-2085 (P7); VAY-2099 slice 1 (P8); VAY-2100 PR2 (P9). No Channex handover in wave 1                                                                                                               |
| 1                  | Haigha House `e41d252d`                    | IDR        | Pay at property; request mode (kept); partial-refund tiers on one room | VAY-2085 (P7); VAY-2099 slice 1 (P8); VAY-2100 PR1–PR3 (P9). Moves as direct booking only (Option N, pending Flamur): this record has no legacy Channex connection                                   |
| later              | Aether A `26e9e98f`                        | USD        | Card on its own onboarded Stripe account; request mode                 | VAY-2099 slice 2; card prerequisites; native markup + G5                                                                                                                                             |
| later              | Animals `6aca326e`                         | USD        | Platform card plus pay at property; request mode                       | Its own Stripe Connect account; VAY-2099 slice 2                                                                                                                                                     |
| later              | Tiga `8f5919ed`                            | IDR        | Platform card plus pay at property; instant                            | Its own Stripe Connect account in IDR, with the K5 IDR run; native markup; its OTA meal plan closed at its handover                                                                                  |
| later              | Nirvana `b8efb175`                         | IDR        | Platform card plus bank transfer; request mode                         | Its own Stripe Connect account in IDR, with the K5 IDR run; VAY-2099 slice 2; the bank-transfer drop reviewed (U4)                                                                                   |
| later              | Miliways `c8efd685`                        | IDR        | Platform card plus bank transfer; request mode                         | Same as Nirvana                                                                                                                                                                                      |
| later (deferred)   | 23 other recently active legacy PMS hotels | mostly IDR | Not read yet                                                           | Decided by Flamur 2026-10-09, deferred: no manifest, owner-bootstrap or per-hotel reads until Flamur says to start                                                                                   |
| never (non-cohort) | Haigha House duplicate `6810de91`          | USD        | No bookings; holds the Haigha legacy Channex connection                | Quarantined in every run, with an explicit disabled auto-open row. Under Option N its legacy Channex connection stays on legacy, untouched, and a daily count of its new legacy bookings must stay 0 |

- Every later wave also needs the wave-2 prerequisites below: the full legacy
  guard and the quarantine → cohort promotion path.
- No platform-account card goes to v2: a card hotel moves only with its own
  Stripe Connect account. Request-mode hotels keep request mode; none is
  switched to instant.
- Wave 1 payment methods: the hotels' `rate_payment_methods` have no
  flexible or non-refundable keys, so legacy falls back to the hotel methods.
  Aether B's offers take card on its own Stripe account; Dolcemare's and
  Haigha's take pay at property.

## One-writer rule, per property

Exactly one runtime mutates each provider stream, scheduler job or table for a
given hotel at any moment (see the cutover rule in the Channex plan). With
waves, the rule holds **per property**: for each wave hotel the order is
legacy owns it → **nobody writes** (its freeze; in wave 1, within the accepted
residual risks) → the target imports it → the target owns it. Legacy-only
hotels stay with legacy throughout.

| Stream                                       | Legacy-only hotels                        | A wave hotel during its window                                                                                                           | A migrated hotel after its handover                                                                                          |
| -------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Channex booking feed (pulled per property)   | Legacy polls and acks                     | Wave 1: legacy until its disable right after the PMS snapshot (F.7). Wave 2+: nobody from the flag. Then OTA revisions queue in the feed | The target pulls and acks, triggered by its booking webhook for the property (H.2, P17), plus the one-time pull at H.4       |
| Channex ARI                                  | Legacy                                    | Nobody after the disable (wave 1) or the flag: OTAs keep selling on legacy's last ARI                                                    | The target (H.5); first push `stop_sell=true`, sales open at H.6                                                             |
| Channex message webhook (global, to legacy)  | Legacy                                    | Still reaches legacy (no per-hotel switch in wave 1)                                                                                     | Target route per property: open preparation item                                                                             |
| Stripe booking payments and Connect accounts | Legacy                                    | Wave 1: still reach legacy's handler (residual risks). Wave 2+: legacy ignores them                                                      | The target confirms payments itself, with no Connect webhook (P11); disputes and refunds are watched in the Stripe dashboard |
| Stripe fixed-plan subscriptions              | Legacy (`FIXED_PLAN_BILLING_MODE=legacy`) | Wave 1: legacy. Wave 2+: nobody (Stripe keeps collecting) until adoption                                                                 | Wave 1: still legacy, until wave 2. From wave 2: the target after adoption (H.3); legacy skips it by the marker (#2980)      |
| Legacy direct booking pages and owner PMS    | Legacy                                    | Wave 1: ALB `410` and redirect (F.2), owner login suspended after the import where safe. Wave 2+: the guard                              | Redirected to the target                                                                                                     |
| Legacy schedulers and in-process loops       | Legacy                                    | Wave 1: not stopped per hotel (residual risk). Wave 2+: the guard skips the hotel                                                        | Same; payouts legacy already started are finished by legacy                                                                  |

Two rules for every wave:

- **Channex feed reads are per property.** Both runtimes read the shared
  booking-revision feed with `filter[property_id]`, so neither takes another
  hotel's revisions. Legacy polls on a schedule; the target has no scheduled
  poll and pulls only on a Channex booking webhook or a `sync_bookings`
  command. But a legacy **ack** deletes a revision from the
  feed. So the hotel's legacy Channex polling is switched off (wave 1: F.7,
  right after the snapshot; from wave 2: the flag at F.2) **before** the target
  starts polling its feed (H.2), never after.
- **Never use `ack_only_with_receipt` as a freeze.** It acknowledges provider
  events without storing them, so they are lost. The global legacy switches
  (`PMS_SCHEDULER_ENABLED`, `PMS_LEGACY_{STRIPE,XENDIT,CHANNEX}_WEBHOOK_MODE`,
  `CHANNEX_ADMIN_*_MODE`, `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE`)
  are **not** used in a wave: they would stop legacy for every hotel. They
  stay as they are until legacy retirement.

Target switches (`next-api`) are global. The ones a wave changes are
`CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned`,
`PMS_CHANNEX_BOOKING_SYNC_MODE` and `CHANNEX_WEBHOOK_INTAKE_MODE` (H.2), and
`PMS_CHANNEX_ARI_SYNC_MODE` (H.5); wave 1 sets those not yet `mutating`.
Production next-api cannot run Channex booking sync, ARI or published-offer
activation today (P16). Once a switch is `mutating`, it applies to every
target property with a `connected` Channex connection, and the import writes
an active legacy connection as `connected` (with its live Channex property ID
and no binding claim). So the switches cannot gate one hotel: a per-property
Channex ownership gate (P12) must keep the target off a wave hotel until its
own H.2. Without it, the first hotel's H.2 makes every imported connected
hotel live, and from wave 2 a hotel goes live as soon as the import commits.

## Legacy per-hotel freeze

Legacy has no per-hotel switch today; the existing cutover switches are
global. `channex_connections.is_active=false` stops legacy's Channex polling,
acks, ARI and provisioning for one hotel, but not inbound message webhooks,
message send/close/no-reply, a re-enable, local booking writes or Stripe.

**Wave 1 (decided): operational freeze.** No legacy code change and no
legacy deploy. Per wave hotel, in this order (F and M give the steps):

1. **Platform ALB rule** (a draft platform PR, toggled and off by default,
   applied with Flamur's **[GO]**): `410` for `pms-api`
   `/api/hotels/<slug>/bookings*` of the three hotels, and their booking pages,
   `/booking/*` and custom domains redirected to v2 (unavailable until their
   reopen). Every path is scoped to the three hotels' slugs or hosts: a shared
   path redirected for everyone would break every legacy-only hotel. It is in
   place from F.2, so no new guest booking, request, cancel or withdraw starts
   in legacy after that point; the next two steps and the residual-risk checks
   rely on it.
2. **No pending booking requests** (a counts-only read shows 0 per hotel), and
   checkouts already in progress have finished.
3. **Open legacy payouts** of the hotel (scheduled, processing, failed) are
   settled or voided.
4. **Final snapshot, then the import** with the wave's cohort.
5. **Legacy Channex disable, right after the PMS database snapshot finishes**
   (Aether B only in wave 1; see the Haigha note below). Record the time.
   Legacy's own route (`POST /admin/channex/disable` on `pms-api`), as a
   super-admin with `X-Hotel-Id` set to the wave hotel's legacy ID: without the
   header the route acts on the caller's **oldest** hotel. It only sets
   `channex_connections.is_active=false` in legacy: no Channex API call; the
   property, its mappings and its last ARI stay. Read back `is_active=false` for
   exactly that hotel and unchanged rows for the others. **Never before the
   snapshot:** the import would then mark the connection disconnected. Taken
   after it, the import writes the connection as `connected`, which is why the
   per-property gate (P12) must hold until H.2. The target's per-property
   `disable` command deletes the Channex property and is **never** used for a
   migrated hotel.
6. **The target takes the hotel over, then pulls** (H.2, Aether B): the
   per-property gate (P12) opens for it and its booking webhook (P17) is
   created. The legacy ack is destructive, so the two never overlap.
7. **Suspend legacy owner logins after the import,** only for owners with no
   other legacy hotel (check `hotels.user_id` and `booking_hotels.user_id`).
   Aether B's owner likely also owns Aether A, so that login likely stays; tell
   the owner not to use Aether B in legacy.
8. **Billing:** no adoption in wave 1 (see Billing before each wave).

Haigha's legacy Channex connection is on the non-cohort record `6810de91`, not
on `e41d252d`, and Dolcemare has no Channex handover in wave 1 (P21 confirms
both by a counts-only read). Under Option N (default, pending Flamur) Haigha
moves as direct booking only: `6810de91`'s connection stays untouched on legacy,
and the daily residual-risk read counts its new legacy bookings (must be 0).

**Wave 2 onward: full legacy guard** (prerequisite W2.1). One
`is_migrated(hotel)` helper, wired into the choke points a single middleware
cannot cover:

1. `pms-api` `get_hotel_id` / `get_hotel_id_by_slug` (about 90 call sites,
   including the oldest-hotel fallback), plus the guest routes that only take a
   booking ID (withdraw, cancel, change request);
2. `booking-api` `get_current_hotel` / `require_current_hotel`, the public slug
   routes, promo increment/decrement, `POST /events`, hotel create/delete and
   the Cloudflare domain routes;
3. the Channex connection repository filter, plus explicit guards on messaging
   send/close/no-reply and on enable;
4. one Stripe/Xendit resolver in the legacy webhook handler, right after the
   signature check and **before** the fixed-plan branch. It resolves the hotel
   from `event.account`, `metadata.hotel_id`, PaymentIntent → payment,
   subscription or account ID, answers `200` and ignores events of migrated
   hotels;
5. the scheduler and loops: pending-booking expiry, stale-unpaid cancellation,
   draft cleanup, property and affiliate payouts (except payouts already
   started, which legacy finishes), Xendit payout polling, Channex polling and
   full ARI sync, calendar auto-open, fixed-plan billing and the promo-usage
   reconciler (by slug);
6. `marketplace-api` affiliate provisioning into PMS.

Email has no hotel context in legacy, so the guard gates the triggering
action instead. Size estimate from the research: 7–10 dev-days for the guard,
2–3 for the per-property Channex handover, 2–3 (+0.5 Xendit) for Stripe
per-account routing.

## Legacy deploys

The `deploy-pms-api`, `deploy-booking-api` and `deploy-marketplace-api`
workflows are **disabled** in GitHub. Re-enabling them would auto-deploy every
merge to production with no approval: the platform environment
`platform-mutations-v2` has no required reviewer, and the coordinated-release
fence covers `next-*` services only. Wave 1 needs no legacy deploy. Every
legacy change (the wave-2 guard, #2980 with it, any fix) goes live as:

1. **[GO: legacy deploy]** Flamur's go for that change and its image digest.
2. `workflow_dispatch` of the platform `deploy.yml` with the explicit digest.
   It copies the running task definition, so environment switches survive,
   and deploys with auto-rollback. The image is built from the reviewed merge
   commit; how it reaches ECR while the app workflows stay disabled is part of
   this item.
3. Record the digest, the go and the `/health` read (for #2980:
   `cutover.fixedPlanBillingMode` is `legacy`) in the evidence folder.
4. Agree the slot with the release coordinator; no legacy deploy overlaps a
   wave window.

## Per-wave prerequisites

Each item names the hotels it applies to and its state on 2026-10-10.

- **P1 Wave-1 operational freeze** rehearsed (see Legacy per-hotel freeze),
  and the platform ALB-rule PR ready for Flamur's go. Wave 1. Decided; not
  rehearsed.
- **P2 VAY-2066 R2 (PR3) live on next-api:** the auto-open producer runs and a
  property without a settings row is on by default (rolling 12). Wave hotels
  with legacy auto-open off get no row and rely on it. Every wave. #3010
  merged; confirm it is live.
- **P3 The Channex enable guard** for legacy-sourced properties without a
  historical binding (#2961) deployed to next-api, even when every wave hotel
  has a binding. Every wave. Merged; confirm it is deployed.
- **P4 VAY-2086 pricing conversion:** the converter,
  `declaredVia: "legacy_import"`, the migration context for Flamur's operator
  account (independent security review, then Flamur's sign-off), the publish
  and parity CLIs, and the gate G1–G5. Every wave. Design #3024; not built.
- **P5 Fixed-plan billing.**
  - **Wave 1:** #2988 (legacy billing webhook claims become `omitted_row`
    instead of `UNOWNED_PROVIDER_EVENT` blockers) is merged: legacy-only hotels
    keep adding `pms.stripe_billing_webhook_events` rows, and each one blocks
    the import today. A wave hotel with only a stale legacy billing reference
    imports as suspended Commission, so `clear-stale-reference` (#2986, target
    side, no legacy deploy) must be available for it. No subscription is
    adopted in wave 1.
  - **From wave 2:** #2980 deployed to legacy `pms-api` in `legacy` mode (with
    the guard, see Legacy deploys), the target side (#2984–#2987) live, and the
    six subscription event types added to the target endpoint.

  Open PRs #2979–#2992.

- **P6 Room facts:** every active room type of a wave hotel has a bed type and
  consistent occupancy limits in legacy, or parity fails `cohortRoomFacts`.
  Every wave hotel; the dry run checks it.
- **P7 VAY-2085 (IDR):** IDR in hotel setup's first currencies and its DB
  function (#3023, merged 2026-10-09) deployed, plus the whole-rupiah
  follow-up; IDR added to the import's `NATIVE_PRICING_CURRENCIES` as a
  follow-up on #3012. Whole-rupiah rounding must not change stored amounts
  before a wave. Dolcemare, Haigha and every later IDR hotel.
- **P8 VAY-2099 slice 1:** v2 request-mode acceptance for pay at property;
  legacy request mode maps 1:1. Its production flag
  `REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED` (default off) is turned on
  with Flamur's explicit go before Dolcemare's and Haigha's reopen (S.0b). Card
  request mode (slice 2) is for later waves only. Dolcemare, Haigha. Not
  built.
- **P9 VAY-2100:** v2 partial-refund tiers, executed automatically.
  - **PR2** fixes the v2 online guest cancel preview, which answers `409`
    today. It is a wave-1 prerequisite for **all three** wave-1 hotels,
    whatever their terms.
  - **PR1–PR3** (the rule, the guest-cancel fix, the wording) are wave-1
    prerequisites for Haigha. Haigha's partial-refund room maps 1:1 as
    `partial_refund [{26, 100}]` for parity (coordinator); its two other rooms
    stay free cancellation with legacy's 7-day default.

  Not built.

- **P10 Card,** for Aether B and the later card hotels:
  - (a) the Finance-token staleness fix VAY-2088 (#3027) is live and the
    existing card publications are republished;
  - (c) the Stripe account refresh (S.0a) is ready;
  - (d) a platform PR sets `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true`,
    flipped only with Flamur's go;
  - (e) per-hotel card readiness is in the gate (G3);
  - (b) the K5 Stripe test-mode run for an **IDR** connected account is not
    needed for wave 1 (Aether B is USD; USD passed on 2026-10-09). Keep it for
    the later IDR card hotels.

  #3027 open; the flag PR is not opened.

- **P11 Target Stripe Connect endpoint: optional.** v2 card acceptance does
  not need the target to receive Stripe Connect webhooks: a payment is
  confirmed by the browser's confirm call plus a 60 s expiry sweep that pulls
  the PaymentIntent. Without the endpoint, a payment from an abandoned tab
  confirms up to about 30 minutes later, and the rooms stay held meanwhile.
  If the endpoint is added (next-api has no Connect secret today), it runs in
  `mutating` mode and only after VAY-2088 (#3027) is live. Disputes and
  refunds are not consumed by the target: watch them in the Stripe dashboard
  during the wave window. Aether B and later card hotels. Resolved.
- **P12 Per-property Channex ownership gate.** The import writes an active
  legacy connection as `connected`, with its live Channex property ID and no
  binding claim. Target webhook intake accepts any `connected` connection, and
  booking persistence checks only `connection_status`. Management commands
  (`sync_bookings`, ARI) refuse a property without an active claim, and the
  VAY-2017 historical-binding transition has no runtime caller today. A
  reviewed mechanism must keep the target off a wave hotel until its H.2 and
  open it one hotel at a time. One option: the import writes wave hotels as
  handover-pending (no live external ID), and a reviewed executor at H.2
  creates the active claim and the connected state. Another: a next-api
  per-property Channex ownership allowlist that H.2 extends. Never `enable`,
  never a new Channex property. Aether B; every later Channex hotel. Not
  built.
- **P13 Native markup:** the marked-up channel supports a native Channex
  channel-level percentage adjustment, confirmed on the staging Channex pair.
  Aether B; later Aether A and Tiga. Open.
- **P14 Room-offer snapshot expiry:** check whether the room-offer snapshots
  that `target:booking-public-bookability:backfill` and the profile publish
  write carry `expires_at`. If they expire, a later profile re-projection makes
  the profile unavailable. Every wave. To check.
- **P15 Phased rehearsal:** wave 1 on an isolated restore of legacy plus a copy
  of the live target, with legacy writing for other hotels during the run (see
  Open preparation items). Its report includes measured step times, an abort
  drill and a provider drill on the staging Channex pair. Wave 1, then each
  wave. Not run.
- **P16 Production Channex capability on next-api.** Production next-api is
  connection-only: the management worker refuses any other scope
  (`channex_worker_scope_unsupported`), and the published-offer targets have no
  runtime sender, receipt reconciliation or activation enabled. Booking sync
  and ARI per property (worker scope and grants), the initial-ARI dispatcher
  (`stop_sell=true`) and published-offer activation must be built and
  rehearsed on the staging Channex pair. Without them H.2, H.5 and H.6 cannot
  run. Aether B; every later Channex hotel. Not built.
- **P17 Target booking intake trigger.** The target pulls the feed only on a
  Channex booking webhook or a `sync_bookings` command; legacy's global
  Channex webhook carries only the `message` mask. At H.2, create a
  property-scoped Channex webhook with the booking event mask pointing at
  next-api (or a global booking subscription whose intake ignores properties
  the target does not own), and prove it with a test booking before H.6.
  Without it, OTA bookings after H.4 stay unacknowledged in the feed. Aether
  B; every later Channex hotel. Not built.
- **P18 Target background jobs and imported rows.** The next-api booking
  lifecycle sweep runs every 60 s and cancels `pending_payment` / `unpaid`
  bookings created more than 30 minutes earlier; imported legacy bookings keep
  their legacy creation time. Without a change it cancels, within minutes of
  the import, the target copies of pending bookings of legacy-only hotels,
  which are still trading on legacy. Pause the lifecycle sweep, the auto-open
  producer and the Channex scheduler from F.1 until the parity result, or
  exclude quarantined properties from them, and prove in P15 that they make no
  provider call or email for those rows. Every wave. Not built.
- **P19 Owner bootstrap for the wave:** the VAY-2017 owner-bootstrap planner
  takes the wave's cohort; today it requires exactly eight owners
  (`legacyOwnerBootstrapPlan.ts`). Wave 1. Not built.
- **P20 next-api image:** production runs an image that includes #2965
  (quote acceptance open to every hotel with Vayada pricing and a
  publication). Production still sets
  `REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS=codex-test-hotel-not-bookable`,
  so an older image would refuse quote acceptance for every wave hotel. Every
  wave. Confirm.
- **P21 Channex connections of the other wave-1 hotels:** a counts-only read
  confirms that Dolcemare and Haigha (`e41d252d`) have no active legacy Channex
  connection. The import would write an active one as `connected`, so it would
  need the same handover as Aether B. Wave 1. To read.

**Wave-2 prerequisites** (not needed for wave 1):

- **W2.1 Full legacy per-hotel guard** (above), deployed by dispatch with
  Flamur's go.
- **W2.2 Later-wave run.** A later wave's hotels were imported as non-cohort
  (private quarantine) by every earlier run. Today the import refuses to change
  an existing disposition (`CATALOG_SOURCE_DISPOSITION_CONFLICT`, by design),
  and the identity import refuses earlier users and quarantined resources
  (`USER_EQUAL_TIME_CONFLICT`, `QUARANTINE_RESOURCE_CONFLICT`). A reviewed path
  must:
  - promote those hotels to cohort (catalog disposition, owner group, links,
    entitlements) and refresh their rows from the new source run;
  - handle a hotel handed back by R1, which was a cohort hotel once;
  - leave earlier waves' hotels untouched (no re-quarantine, no disabled
    auto-open row);
  - override stale target copies of rows the earlier run imported (for
    example bookings P18 did not protect).
- **W2.3** Each later card hotel's own Stripe Connect account, and VAY-2099
  slice 2 (card request mode) for Aether A, Animals, Nirvana and Miliways.

## Billing before each wave (T-7 days → T-1 day)

Details and commands: `legacy-fixed-plan-billing-handover.md` (billing stack).
There is no billing freeze: legacy keeps billing every legacy-only hotel.

**Wave 1 adopts nothing.** At T-7, run the read-only adoption
`--mode inventory` to see whether a wave-1 hotel has a live fixed-plan
subscription. If one does, it stays on legacy until wave 2 (no legacy deploy,
no double charge). The import lands a legacy Fixed hotel as suspended
Commission until adoption, which may keep it from being bookable in the
target: settle this before wave 1 (open decision 5). Also at T-7, a
counts-only read of the wave hotels' legacy `hotel_payment_settings`
`stripe_billing_*` references finds hotels with only a stale reference (an
abandoned checkout): after the import, `clear-stale-reference` sets each of
them back to active Commission (P5). No-adoption is the coordinator's
2026-10-10 wave-1 decision; Flamur confirms it with the go-day items.

**From wave 2:**

1. At T-7, run `--mode inventory`. Find the wave hotels' fixed-plan
   subscriptions, including wave-1 hotels still billed by legacy.
2. Check each one's period end against the 24 h adoption guard. If a renewal
   falls in the window, adopt right after the renewal invoice is paid, or move
   the wave. Re-check at T-1.
3. At T-1, confirm in Stripe that no wave hotel has an open fixed-plan Checkout
   Session. One that completes later shows up as `adoptable` at H.3.
4. Stripe settings (human, once): retries exhausted → mark the subscription
   `unpaid`; the customer portal allows no subscription changes.
5. The legacy endpoint keeps the six subscription event types: legacy-only
   hotels still need them. The target finishes legacy events it does not own as
   `ignored_unowned` (#2984).

Today the inventory classifies a live subscription of a legacy-only hotel as
`blocked` and exits non-zero, so it cannot serve as the reopen gate as it is
(open preparation item). Until it can, the gate is read from its output for
the wave hotels only.

## Readiness gate (T-2 days, each wave)

1. Every prerequisite of the wave's hotels (P1–P21, plus W2.x from wave 2)
   holds, and the rehearsal report (P15) is accepted.
2. A `target:cutover:dry-run` run with the wave's cohort completed with parity
   `GO` and smoke. Its report and checksum are the `--approved-run-*` inputs.
3. The wave's cohort manifest is reviewed, and the slug/domain collision
   pre-check is clean against the native properties. The orchestrator refuses
   to bind a cohort with a hotel that does not resolve to exactly one canonical
   property (`COHORT_HOTEL_UNRESOLVED`) before it writes the cohort row, so a
   corrected manifest can reuse the same source run.
4. Pricing (VAY-2086): the dry-run plan of every wave hotel is reviewed and its
   digest approved. Every finding is resolved or accepted; `block` sources are
   fixed in legacy before the freeze. Quote parity against legacy passes on the
   sample dates. OTA-only rate plans (meal plans) of a wave hotel are listed for
   closing before H.5; "unbound" is not "closed".
5. The wave hotels' owners are notified of their window. An owner who keeps
   another hotel on legacy (Aether A and B likely share one) is told that the
   migrated hotel moves to the new PMS and its legacy copy must not be used.
   Owners of request-mode hotels are asked to accept or decline every pending
   booking request in legacy before the freeze (F.3).
6. **OTA exposure during the freeze.** From the hotel's legacy disable (wave
   1, F.7) or flag (wave 2+, F.2) to H.5 nobody pushes ARI for it, so its OTAs
   sell on legacy's last ARI and a booking on one OTA does not close the last
   room on another. If that measured time exceeds 2 h (the default
   assumption), or the hotel is nearly full for the window's dates, close its
   OTAs with a stop-sell set directly in Channex by the cutover commander,
   right after the legacy disable (legacy no longer pushes ARI then), and read
   it back. Never close dates in legacy before the snapshot: those closures
   import as manual limit-0 blocks that owners cannot reopen, so activation
   would open nothing. If that happened, list and remove them before H.6.
7. Release freeze: no **other** next-api, platform, hotel-setup or legacy
   deploy overlaps the window; confirm with the release coordinator. The
   window's own planned applies are listed in advance, each with its PR, its
   expected rollout time and its readback: the ALB rule (F.2, and R1's toggle
   back), the request acceptance flag and the card acceptance flag (S.0b), and
   the next-api environment changes of H.2 and H.5. Under a release hold
   Terraform skips the next-api rollout, so confirm every environment change
   by its environment or `/health` readback, not by the apply.
8. The production backup proof and the target attestation
   (`vayada_migration_evidence`) are prepared for the exact run ID.
9. For wave 1, every rehearsal and dry-run target starts from a fresh copy that
   no migration run has touched. A target that already had an identity or
   catalog run without a cohort blocks a later cohort run
   (`USER_EQUAL_TIME_CONFLICT`, `QUARANTINE_RESOURCE_CONFLICT`,
   `CATALOG_SOURCE_DISPOSITION_CONFLICT`). From wave 2 the production target
   already holds earlier waves: later-wave rehearsals run on a copy of it, which
   is what W2.2 must make work.
10. Each hotel's handover slot (H.2–H.6) is set at a quiet time for that
    hotel. In wave 1 only Aether B has one.
11. Counts-only reads per wave hotel, repeated in F: legacy pending booking
    requests, open legacy payouts (scheduled, processing, failed), and (wave 1)
    whether it has a live fixed-plan subscription or a stale billing
    reference. Settle or void open payouts from T-1 to T-0: in-flight payouts
    settle on Stripe's or Xendit's schedule, and scheduled ones may be dated
    later. Who voids a payout, and how it is reissued in the target, is an open
    preparation item.

## Per-wave window

Estimate per wave: 3.5–4.5 h, plus each hotel's handover. The import extracts
and imports every legacy row, so its time does not shrink with a small wave.
Every step records evidence in the run's evidence folder. The pricing design
cites v1 labels; v1 → v2: F.3 (pause the target's writers) → F.1; F.1–F.2
(legacy freeze) → F.2–F.7; H.2 (endpoint repoint) → H.2 (per-property takeover);
H.6 (Airbnb) → H.7. S.0, S.0a, S.0b, H.4, H.5 and O.1–O.2 keep their meaning.

### F — Freeze the wave hotels (~30 min, plus waiting for open items) **[GO: freeze]**

1. **Target.** Pause the target's native writers on the tables the imports
   lock: domain applies abort after 5 s on lock contention, and parity takes
   `SHARE` locks. In practice, native hotel-setup and PMS write paths go to
   maintenance for every native hotel. Also pause the next-api background jobs
   that would act on imported rows (P18: the booking lifecycle sweep, the
   auto-open producer, the Channex scheduler) until the parity result, unless
   P18 excludes quarantined properties from them. Both pauses end at S.4 (see
   there).
2. **Stop new legacy bookings for the wave hotels** (time T). Wave 1: toggle on
   the platform ALB rule (**[GO]** by Flamur): `410` for `pms-api`
   `/api/hotels/<slug>/bookings*` and the booking pages, `/booking/*` and
   custom domains redirected to v2, all scoped to the wave hotels. From wave 2:
   set each hotel's `is_migrated` flag. Legacy keeps serving every other hotel:
   there is no global maintenance page or write block.
3. **No pending booking requests.** Every legacy `pending` request of a wave
   hotel is accepted or declined in legacy by its owner, and checkouts already
   in progress have finished or expired. After T the `410` also blocks
   `confirm-authorization`, so an Aether B checkout in progress can only finish
   through legacy's Stripe webhook, or expire. Gate: a counts-only read shows 0
   pending requests per wave hotel. A migrated `pending` request would become
   `pending_payment` with no acceptance mode or deadline, and the target's
   stale-unpaid sweep would cancel it once the sweep runs again (imported
   bookings keep their legacy creation time, so they are already past its 30
   minutes); a booking still `pending_payment` at the snapshot meets the same
   sweep.
4. **Open payouts and other open items.** The wave hotels' open legacy payouts
   (scheduled, processing, failed) were settled or voided from T-1 (readiness
   item 11); the counts-only read shows 0. Record open drafts and anything else
   still open, for reconciliation after the import (target state wins).
5. **Drain:** wait two booking-poll intervals plus 10 minutes. From wave 2,
   confirm that legacy's `last_*_sync_at` for the wave hotels has stopped and
   its logs show no poll, ack or ARI for them (Channex logs cannot tell the
   stacks apart: both use the same API key). Wave 1: legacy keeps polling
   Aether B's feed until F.7, so its OTA bookings keep landing in legacy, and in
   the snapshot; legacy's background jobs also keep running for the wave
   hotels (residual risks). Confirm that the wave hotels' booking, draft,
   payment and payout rows have no write since T other than those OTA bookings
   (the read plan names the exact tables).
6. **Freeze proof and final snapshot:** take manual snapshots of the four
   legacy databases, record the wave hotels' last-write evidence, and compute
   `--freeze-proof-sha256`. Legacy-only hotels keep writing during the
   snapshots (open preparation item: snapshot skew).
7. **Wave 1: legacy Channex disable, right after the PMS database snapshot
   finishes,** for Aether B (the only wave-1 hotel with a Channex handover;
   Haigha's connection on `6810de91` stays untouched under Option N), as in
   [Legacy per-hotel freeze](#legacy-per-hotel-freeze) (super-admin,
   `X-Hotel-Id`, local `is_active=false` only), with its readback. Record the
   PMS snapshot time S and the disable time. Never before the snapshot. Then
   confirm that the hotel's `last_*_sync_at` has stopped. An OTA booking that
   legacy acked between S and the disable is in legacy only. The daily check
   (`created_at` > S) finds it, and it is re-ingested into the target through
   the target's revision-by-ID recovery path before the hotel's reopen. Never
   enter it by hand: a hand-entered booking has no Channex booking mapping, so
   the OTA's later changes or cancellation would not apply to it.

### M — Extract and import through the orchestrator (~60–90 min) **[GO: cutover]**

1. Create the isolated preprod-labelled source restore and its attestation
   ([extraction](../packages/backend-migration/README.md#immutable-source-extraction)).
2. Run `target:source:extract` with the manifest, the schema revision, the four
   snapshot ARNs and the freeze proof.
3. Run `target:cutover` with production/preprod, the common arguments, the
   wave's `--cohort`, the backup proof, the approved dry-run report and the
   approval report. Confirm with `PRODUCTION_CUTOVER:<run>:<source-run>`.
   - It runs schema → extraction → identity → catalog (prerequisites → media →
     complete) → booking → pms → marketplace → finance → parity.
   - It pauses at `AWAITING_SMOKE` (exit `4`).
   - Do **not** run the domain CLIs one by one. `target:parity` on its own also
     refuses `--source-env production`; the orchestrator handles the pairing.
4. Exit `2` (no-go) or an unexplained exit `3` → R1 for the whole wave.
5. **Wave 1, after the import:** suspend the legacy owner logins where safe
   (owners with no other legacy hotel; check `hotels.user_id` and
   `booking_hotels.user_id`).

### S — Smoke (~30 min, plus pricing per hotel)

Order: **S.0a → S.0 → S.0b → S.1–S.4**. S.0 and S.0b may swap. The public
gate needs both a fresh bookability profile and a current pricing
publication. A pricing revision or publication does not stale the profile:
the profile's `freshness_status` is computed when it is published (room-offer
snapshots, booking and payment settings, online-card readiness) and stored
until its next projection.

**S.0a — Stripe refresh, card hotels only (Aether B in wave 1).** Refresh the
Stripe account and record online-card execution evidence through Finance's
readiness path; the import writes neither. It comes before S.0 and S.0b: a
profile projected before card readiness exists does not list card until it is
re-projected, and publishing prices binds the Finance source. Dolcemare and
Haigha skip it.

**S.0 — Make each wave hotel bookable.** The cutover writes the catalog, the
native property links, the property-scoped `property-management` entitlement
and the setup rows native onboarding writes (pricing settings, verified room
labels, operating calendar, inventory coverage, the Financials module as
legacy had it; see the cohort contract). It then sets
`lifecycle_status = 'active'` for each wave hotel whose profile is `complete`
and that meets every VAY-2066 readiness item (a–g). Parity reports how many
wave hotels are `active` and `provisioning` and what the provisioning ones
miss, and fails an active one that is not ready or a ready one still
provisioning. The PMS step does not rerun after a fix: for a hotel fixed
before reopen, re-read its readiness (parity, or `COHORT_READINESS_SQL`) and,
only when every item holds, activate it with the platform admin lifecycle
command (`PATCH /properties/:propertyId/status`, `active`), which does not
check a–g itself. Otherwise accept it staying unbookable. The cutover does not
write the following:

- `profile_status` is `complete` only for a hotel that was live in legacy, has
  a public-eligible owner and has country, city and timezone. Fix any
  `incomplete` wave profile before reopen, or accept it staying unbookable. A
  profile edit after the import raises the profile revision, so the migrated
  operating calendar no longer matches it (VAY-2066 criterion d) and the
  auto-open job refuses it: re-save that hotel's operating calendar in the PMS
  afterwards.
- The public bookability profile
  (`distribution.public_hotel_bookability_profiles`). Publish it per wave
  hotel. **Card hotels use the normal booking-profile publish**, not
  `target:booking-public-bookability:backfill`: on conflict the backfill resets
  `accepted_methods` to pay at property. Pay-at-property hotels may use either.

Calendar auto-open: a wave hotel with legacy auto-open on keeps an explicit
enabled row with its mode. One with it off gets no row and takes the new
on-by-default (rolling 12), which keeps its dates opening as legacy "off" did.
Non-cohort hotels get an explicit disabled row; earlier waves' hotels keep
theirs. The VAY-2066 producer
selects a hotel only once its rooms are verified and it has an operating
calendar and pricing settings, which the import writes for every carried wave
hotel that has their prerequisites; check that it selects each of them.

Financials: parity's `COHORT_MODULES_REPORTED` finding lists (hashed) the wave
hotels whose legacy module was skipped, with the reason and legacy state, and
the stored modules kept as they were. For each hotel imported with Financials
on, run `target:financials:readiness -- --property-id <id> --expect-active`
and resolve its findings before reopen. The VAY-1138 activation runbook's
per-property approval covers activating Financials in the target; these
hotels carry the activation they had in legacy (decision for the wave's
approver). A skipped hotel that had Financials on stays without it: decide per
hotel whether to make its organization the owner or to activate it later
through the VAY-1138 operator path.

**S.0b — Publish prices (VAY-2086), per hotel.** Wave 1 flips two global
next-api flags first, each once and each with Flamur's explicit go:

- **[GO: card acceptance flag]** `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED=true`
  (P10 d), before Aether B's gate (or at T-1);
- **[GO: request acceptance flag]**
  `REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED` (VAY-2099 slice 1, P8),
  before the gate of Dolcemare and Haigha.

Read each one back on next-api (readiness item 7). Then, per hotel, run the
dry run, compare its digest with the approved one, apply with
`--apply-for-property` and the approved digest, and run the gate G1–G4
(`pms:legacy-pricing:parity`). G3 checks that the acceptance mode maps 1:1: it
accepts request mode for pay-at-property hotels once slice 1 is live, and for
card hotels only after slice 2. S.0b runs after `AWAITING_SMOKE`;
resume-from-smoke only validates the smoke report, so parity is unaffected.
F.1 still holds: the tool uses commands over a direct pool, after the imports.
Auto-open then re-plans the rooms that gained offers. A NO-GO → R0 for that
hotel.

Then check that each wave hotel passes the VAY-1543 public pricing rule:

- exactly one active `hotel_group` organization holds both property links
- an applicable active `pms` entitlement exists and none is suspended
- lifecycle `active` and profile `complete`
- a location row and an active canonical slug
- a bookability profile that is `public_safe`/public/fresh/ready with payment
  methods, and a current pricing publication

**S.1–S.4.**

1. For each wave hotel, check:
   - rooms, rate plans (the published prices) and the availability calendar
   - upcoming and past reservations, and the open items recorded at F.4
   - balances and folios
   - photos
   - the public booking page, on its custom domain where one exists
   - the acceptance mode (instant, or request for Dolcemare and Haigha) and,
     for Haigha, its partial-refund tiers
2. Owner isolation: each owner sees only their own migrated hotels and is
   refused on any other hotel, including their hotels still on legacy.
3. Native Owner properties and earlier waves' hotels are unchanged.
4. Save the `production-cutover-smoke.v1` report and resume the same run with
   `--resume --smoke-report`. Once the resumed run has completed and every
   S.0b publish is done, lift the target maintenance and the paused background
   jobs (F.1): the reasons for them (the 5 s apply timeout, parity's `SHARE`
   locks, P18) end with the run, while H runs per hotel, hours apart.

### H — Provider handover, per hotel, strictly in order

Run H for one hotel at a time, at its quiet-time slot. In wave 1 the Channex
steps (H.1, H.2, H.4–H.7) apply to Aether B only: Dolcemare has no Channex
handover in wave 1, and Haigha moves as direct booking only (Option N).

1. **[GO: provider apply 1]** Confirm legacy stays silent for the hotel: wave 1,
   its legacy `channex_connections.is_active` is still `false` and its
   `last_*_sync_at` has not moved; from wave 2, its guard skip logs. Verify for
   two polling intervals.
2. **[GO: provider apply 2] Channex takeover.**
   - Wave 1 only, if not already set on next-api (P16 must be live):
     `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned`,
     `PMS_CHANNEX_BOOKING_SYNC_MODE=mutating`,
     `CHANNEX_WEBHOOK_INTAKE_MODE=mutating`. With the per-property gate
     (P12) in place, this makes no other hotel live.
   - Open the per-property gate for this hotel only (P12). Never `enable`,
     delete, disable or re-create the Channex property; #2961 refuses `enable`
     for an imported property without a binding.
   - Create the hotel's property-scoped Channex booking webhook to next-api
     (P17). Do not repoint the global Channex webhook: it keeps serving
     legacy-only hotels.
3. **[GO: billing adoption]** From wave 2 only (wave 1 adopts nothing), for a
   wave hotel with a fixed-plan subscription. Set target
   `FINANCE_BILLING_OPS_EMAIL` and confirm `STRIPE_WEBHOOK_INTAKE_MODE=mutating`
   and `FINANCE_SOURCE=target`. Run the adoption command as a dry run, then with
   `--apply-for-property`. Re-run `--mode inventory`: the hotel's subscription
   is `adopted`, `ending` or reverted. From now on legacy skips it by its
   marker. This is a reopen gate for the hotel.

   Card hotels: the target confirms payments without a Connect webhook (P11).
   Disputes and refunds are not consumed by the target: watch the hotel's
   Stripe account in the dashboard from the freeze through the watch period.

4. Pull the hotel's unacknowledged Channex booking revisions once: the OTA
   bookings made during its freeze are only in the feed. Reconcile the counts
   (feed count for the property before the pull, bookings created in the
   target). Re-ingest any booking legacy acked between S and its disable (F.7)
   by revision ID.
5. **ARI, first push.** Before it:
   - re-run the pricing gate G1–G4 (VAY-2088 is live for wave 1, P10 a, so a
     Stripe account webhook no longer stales the pricing token);
   - close or deactivate the hotel's OTA-only rate plans (meal plans, U9; none
     in wave 1, Tiga in its wave);
   - run a diff/dry-run of the first availability and rate push. Published
     offers serve as PMS rate plans (VAY-1422).

   Then, wave 1 only, set `PMS_CHANNEX_ARI_SYNC_MODE=mutating`. The hotel's
   first v2 ARI push is `stop_sell=true`: its OTAs close here, on purpose.
   Verify the stop-sell readback for the whole horizon.

6. **Markup, then activation (sales open on the OTAs).**
   1. For a hotel with a legacy markup (Aether B: 10% on one channel),
      configure the native Channex channel-level price adjustment once per
      marked-up channel, **only now**, while stop-sell holds. Legacy's last
      push already carries the markup in that channel's rates, so an
      adjustment set earlier would sell that channel at about 1.21× until the
      first v2 push. Never combine it with an old-target markup
      (`PMS_CHANNEX_MARKUPS_MODE`, `update_markups`).
   2. Run **G5** while stop-sell holds: on one sample date the rate the
      marked-up channel shows equals the v2 published total × 1.10. A missing
      or doubled adjustment is NO-GO for that hotel's OTA reopen. If the rate
      cannot be read while stop-sell holds, record that as an explicit
      accepted risk with the go, and check right after activation with the
      stop-sell push ready.
   3. Activate the hotel's published offer target (P16); activation requires
      the exact configuration readback and the initial ARI readback.
7. Airbnb all-hotels (VAY-1551) stays off for wave 1 until day +1. For later
   waves, confirm with the VAY-1551 owner how new hotels join.

### O — Reopen, per hotel **[GO: reopen]**

1. **Final gate immediately before:** the pricing gate (G1–G4, and G5 where it
   applies) returns GO, the hotel's readiness holds, its billing is adopted or
   not applicable, for a request-mode hotel the request acceptance flag is on,
   and every booking legacy acked between S and its disable has been
   re-ingested (F.7). Only GO hotels reopen. Then make the hotel bookable, make
   sure its booking page and custom domain serve the target (wave 1: the F.2
   redirect already points there; from wave 2: switch them now), and remove
   the operator membership the pricing tool used.
2. **Watch for two hours:** provider sync errors, duplicate bookings, webhook
   failures, no unacknowledged Channex revision for the hotel older than the
   threshold the rehearsal sets, owner support, disputes in the Stripe
   dashboard, and any legacy write, ack, ARI or Stripe effect for the migrated
   hotel. Run the stale-publication check (below) and, in wave 1, the first
   daily residual-risk read.

## Rollback

**R1 — hand back to legacy, before a hotel's handover.** For the whole wave
(orchestrator no-go, a global failure) or for one hotel. It is clean only
while the target owns none of the hotel's streams: before its H.2 (no target
poll or ack of its feed) and before its H.3 adoption.

1. Whole wave: `target:cutover:abort` only marks the run aborted; imported
   rows stay in the target. They must stay unpublished, with no owner access.
   Defining that state (or a cleanup) is preparation work.
2. Suspend in the target every handed-back hotel the PMS step set `active`
   (platform admin lifecycle command, `suspended`), which also withdraws its
   public bookability. No native transition leads back to `provisioning`. A
   retried run does not touch suspended hotels and parity does not count them:
   reactivate each one with the same command once it moves again.
3. Take the target off the hotel's Channex property first: its imported
   `connected` connection must stay behind the per-property gate (P12) or be
   set offline. Then undo the hotel's legacy freeze. Wave 1: set its legacy
   `channex_connections.is_active` back to `true` through a reviewed update,
   **not** the legacy `/admin/channex/enable` route, which runs
   `provision_property` (it writes rooms, rate plans and the messaging app to
   Channex, after a pre-flight check that can fail); restore any suspended
   owner login; toggle the ALB rule off for the hotel (Flamur's go). From wave
   2: clear its `is_migrated` flag. Legacy then polls and acks the revisions
   queued during the freeze. Rehearse this in P15.
4. Card hotels, from wave 2: reconcile in legacy the Stripe events of the
   window. The guard answered them `200` and ignored them, so Stripe does not
   redeliver them.
5. Lift the target maintenance when no other wave hotel needs it. Legacy
   remains the hotel's source of truth. Its later move needs the later-wave run
   to handle a hotel that was already a cohort hotel once (W2.2).

**R0 — suspend one hotel in the target, from its handover on.** A hotel that
fails its gate after its H.2 (or before it, when R1 is not chosen) is
suspended alone; the rest of the wave continues. It does not sell anywhere
until it is fixed: there is no pay-at-property fallback.

1. **Record.** Keep the NO-GO report (hashed property) and the failing check in
   the evidence folder. Tell the wave's approver and the owner.
2. **Close its OTAs deliberately.** If its H.5 ran, the first v2 push was
   `stop_sell=true`: do not activate. Otherwise push a stop-sell (or 0
   availability) for the whole horizon, through its H.5 first push without
   activation where that can run, else as a manual Channex stop-sell by the
   cutover commander. Verify the readback. Never close a hotel by deleting,
   disabling or disconnecting its Channex property (this replaces the
   per-property `disable` in the pricing design's suspend steps). Keep its
   booking intake running, and for a hotel suspended before its H.2 run the
   H.2 takeover and the H.4 pull anyway: OTA bookings made during the freeze
   are only in the feed.
3. **Suspend:** `PATCH /properties/:propertyId/status` with `suspended`. This
   withdraws public bookability. O.1 skips the hotel: its booking page and
   custom domain stay on its unavailable v2 page.
4. **Leave the data.** Its imported data and pricing revisions stay; its
   reservations stay in the target PMS for the owner and staff.
5. **Fix forward.** Price or terms cause: the corrected converter republishes
   the tool's own revision, or the owner uses "Save prices" (the tool then
   stops). Card cause: S.0a or the Finance fix. Re-run the gate until it
   returns GO.
6. **Reactivate.** Re-read readiness (parity or `COHORT_READINESS_SQL`), set
   `active` with the same command, run the ARI dry run, activate (H.6), and
   serve its booking page from the target (O.1). Remove the operator
   membership.

**After a hotel's reopen:** fix forward. Never restore a backup over new
writes, never hand a reopened hotel back to legacy.

**Triggers:**

- any **[GO]** gate fails
- parity no-go, or an unexplained review result
- an owner can see another hotel
- a provider double-write or a missed booking
- a legacy write, ack, ARI push or Stripe effect for a hotel after its freeze
- a target poll, ack or ARI push for a legacy-only hotel
- an uncertain dispatch outcome
- an error spike during the watch

## Wave-1 residual risks (accepted by Flamur on go-day)

Wave 1 runs without the legacy guard, so legacy still serves the wave hotels
in some paths. Flamur accepts this list as **one go-day acceptance item**. Its
checks form one fixed counts-only read plan, run daily with Flamur's go for the
wave window plus 7 days. T is the F.2 time. The ALB `410` rule and the
redirects are a draft platform PR, toggled and off by default, applied only
with Flamur's go on go-day.

| Residual risk                                                                                                                                              | Covered by                                                                                                   | Daily counts check                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy emails about expired requests                                                                                                                       | 0 pending requests at the freeze (F.3)                                                                       | None needed                                                                                                                                                   |
| A guest cancel or withdraw in legacy issues a real refund on Aether B's Stripe account, and emails                                                         | The ALB rule (guest routes only; the owner's admin cancel stays open to Aether B's owner, who keeps a login) | Wave hotels' legacy bookings cancelled or declined with `updated_at` > T                                                                                      |
| New or in-flight legacy bookings                                                                                                                           | The ALB rule                                                                                                 | Wave hotels' legacy bookings and drafts with `created_at` > T; for Aether B's OTA bookings, `created_at` > S (the PMS snapshot time), each re-ingested by F.7 |
| A Channex re-enable, message or delete from legacy                                                                                                         | Owner login suspension (likely not for Aether B, whose owner owns Aether A)                                  | Wave hotels' `channex_connections` active, or `updated_at` > T                                                                                                |
| Legacy refund webhooks answer `500` for refunds made in v2; Stripe retries for about 3 days                                                                | Accepted, or a tiny legacy fix with a deploy go                                                              | None                                                                                                                                                          |
| A legacy payout for a booking cancelled in v2                                                                                                              | Payouts settled or voided before the snapshot (readiness item 11, F.4)                                       | Wave hotels' legacy payouts created or changed after T                                                                                                        |
| The target later dispatches imported legacy payouts (a dispatch route exists; imported wave-hotel payouts keep `scheduled` / `failed` with no provider ID) | Imported as needs-review (target-side change in progress)                                                    | None                                                                                                                                                          |
| Duplicate payment-confirmation emails when v2 captures a legacy-created PaymentIntent                                                                      | Accepted                                                                                                     | None                                                                                                                                                          |
| OTA bookings for Haigha keep landing on the legacy record `6810de91` (Option N)                                                                            | Its legacy Channex connection stays untouched on legacy                                                      | New legacy bookings for `6810de91` with `created_at` > T: must be 0                                                                                           |
| Disputes and refunds on Aether B's account are not consumed by the target                                                                                  | Watched by hand                                                                                              | Disputes in the Stripe dashboard                                                                                                                              |

Also not covered, for the coordinator to confirm in the acceptance item:

- OTA guest messages for the wave hotels keep arriving at legacy's global
  Channex message webhook, not at the target, until messaging per property
  exists (open preparation item).
- Legacy's in-process promo-usage reconciler (by slug) and its other loops
  still run for the wave hotels; they write only legacy rows.
- `marketplace-api` affiliate provisioning into PMS still runs for the wave
  hotels.

## Stale pricing publications

A publication serves quotes only while its three source tokens (rooms, terms,
finance) are current. Any Finance, room-facts or terms change unpublishes a
hotel's offers until someone republishes them ("Save prices"), and no alert
fires today.

- **Owner during waves: Vayada ops**, with an alert on the read-only
  `pms:pricing:publication-freshness` check (the alert is to be built) and the
  pricing tool's `--stale-count`.
- Run it during each O.2 watch and daily for the first week after each wave.
  Any non-zero count is investigated; the owner's "Save prices", or the tool
  for its own revision, republishes.
- VAY-2088 (#3027) removes the staleness that Stripe `account.updated`
  webhooks cause today.

## Between waves

- **Accept the wave** after its first week: no stale publications left, no
  legacy write or provider effect for its hotels (wave 1: the daily
  residual-risk reads are clean or explained), its open items from F.4
  reconciled, owner support settled. Record the acceptance.
- Legacy keeps running for legacy-only hotels. Their billing, Channex and
  Stripe stay on legacy; any legacy fix follows Legacy deploys.
- Prepare the next wave: its cohort manifest, its prerequisites (W2.x and the
  per-hotel needs in [Waves](#waves)), a fresh counts read for its hotels (for
  example new last-minute tiers, U13), its pricing dry-run plans, and a
  rehearsal against a copy of the production target that already holds the
  earlier waves.
- Day +1 after each wave: review replies for its hotels (VAY-1532/1533);
  Airbnb all-hotels (VAY-1551) after wave 1.

## After the last wave

- **Legacy retirement (VAY-1363)** starts only after the last wave is accepted,
  not after wave 1. An archive-restore proof comes before any deletion.
- Hotels that never move (for example `6810de91` and the rest of the legacy
  estate) are decided in the retirement plan, including their fixed-plan
  subscriptions: the billing note's "cancel at period end, with notice" step
  applies then, not at wave 1.
- The global legacy switches and the platform freeze variables are used, if
  at all, for that final retirement.

## Open decisions (for Flamur)

1. **A wave hotel that fails before its handover (H.2):** hand it back to
   legacy (R1 for one hotel: it keeps selling, but its later move depends on
   W2.2) or suspend it in the target (R0: no sales until fixed)? Proposed: R1
   when the fix needs more than a day, R0 otherwise.
2. **Aether B's markup, only if P13 fails:** close that channel's rate plan, or
   accept a 10% lower OTA price on it.
3. **Later waves:** their order and timing, and when work on the 23 deferred
   hotels starts.
4. **Hotels that never move,** at legacy retirement: billing, access and data.
5. **A wave-1 hotel with a live fixed-plan subscription** (only if the T-7
   inventory finds one): it stays billed on legacy until wave 2, but the import
   lands it as suspended Commission until adoption, which may keep it from
   being bookable in the target. Move it to a later wave, or accept a target
   billing state for it that charges nothing extra.
6. **Haigha's Channex:** its legacy Channex connection sits on the non-cohort
   record `6810de91`; `e41d252d` has none. Default, **Option N:** Haigha moves
   in wave 1 as direct booking only, with no Channex handover; `6810de91`'s
   connection stays untouched on legacy, watched by the daily count. **Option
   R:** rebind the Channex property `e13f3645` to `e41d252d`; it is
   provider-side and risky.
7. **Aether B if P16, P17 or P12 is not ready for wave 1:** its OTAs cannot be
   handed over, and it cannot move direct-only while its OTAs stay on legacy
   (one inventory in two systems). Keep Aether B for a later wave, or hold
   wave 1 until they are ready.
8. **Wave-1 billing:** confirm that wave 1 adopts no fixed-plan subscription
   (the coordinator's 2026-10-10 decision; the earlier plan adopted the wave
   hotels' subscriptions).

## Open preparation items

- **Wave-1 operational freeze:** rehearse F.2–F.7 and M.5 per hotel,
  including the `X-Hotel-Id` header on the legacy Channex disable, the readback
  of the other hotels' rows, re-ingesting an OTA booking that legacy acked
  between the PMS snapshot and the disable by revision ID, and R1's reviewed
  `is_active=true` update.
- **ALB rule:** the draft platform PR (`410` on the wave hotels' legacy booking
  API routes, redirects of their booking pages, `/booking/*` and custom
  domains), toggled and off by default.
- **Residual-risk read plan:** the fixed daily counts-only plan for the wave-1
  checks, reviewed once and run daily with Flamur's go.
- **Messaging per property:** legacy's global Channex message webhook keeps
  serving legacy-only hotels. Migrated hotels need their OTA message events in
  the target (a property-scoped Channex webhook to next-api, or a target
  subscription whose intake ignores legacy-only properties). Owner: the
  per-hotel Channex/Stripe handover work.
- **Per-property Channex gate, production Channex capability, booking intake
  trigger and background jobs (P12, P16, P17, P18):** owners and PRs to be
  named. The rehearsal shows that the target neither pulls the feed nor pushes
  ARI for an imported wave hotel before its H.2, and that S.0b triggers no
  provider write before H.5.
- **Payout voids:** who voids an open legacy payout of a wave hotel, and how
  the owed amount is reissued in the target.
- **Pricing design labels:** the pricing design (#3024) cites v1 step labels
  (for example "F.3 still holds", now F.1); update it to the v2 map in Per-wave
  window.
- **Billing inventory per wave:** a class for live subscriptions of legacy-only
  hotels that does not block, so `--mode inventory` can be the per-wave reopen
  gate.
- **Snapshot skew:** the four legacy snapshots are taken while legacy keeps
  writing for legacy-only hotels, so a row written between two snapshots can
  reference a row missing from another. Prove in the phased rehearsal that the
  domain imports and parity accept this for non-cohort rows, and define what
  the freeze proof attests (the wave hotels' rows only).
- **Legacy deploy build path:** how a reviewed legacy image reaches ECR while
  the app deploy workflows stay disabled. Fix `docs/legacy-pms-freeze.md` in
  the platform repo, which wrongly claims an approval step.
- **Room-offer snapshot expiry (P14).**
- **Stale-publication alert** on `pms:pricing:publication-freshness`.
- Abort semantics for imported rows (R1), including a retried wave on a
  production target that already holds the aborted run.
- Billing handover stack (#2979–#2992).
- Known gap: `COHORT_SCOPE_VERIFIED` does not check job or outbox rows for
  properties outside the cohort. The import writes none for them, so parity
  relies on the native writers being paused (F.1).
- Decided: the cutover activates wave hotels with a complete profile that meet
  every readiness item (VAY-2066 a–g); the rest stay `provisioning`.
- Legacy PMS module activations map to the runtime's property-scoped
  `module:*` entitlements (financials only; see the cohort contract). Open
  decisions: a hotel without a legacy row imports Financials off (legacy reads
  it as off), while a native new hotel starts with it on; the Owner can switch
  it on in the Feature Hub. Legacy `affiliates` is not carried, although
  booking-admin's Refer-a-guest setting still reads `module:affiliates`.
  PMS-only legacy hotels get `operator` native links unless a booking or
  marketplace link makes the organization the owner, so their Financials is
  skipped (`owner_organization`), as native setup requires the owner.
