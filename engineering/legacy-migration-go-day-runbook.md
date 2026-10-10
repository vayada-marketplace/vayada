# Legacy → TypeScript migration go-day runbook (VAY-1362)

_Draft v1, 2026-10-08. Not yet rehearsed. Sequences the existing tooling in
[`packages/backend-migration`](../packages/backend-migration/README.md),
[`channex-webhook-cutover-plan.md`](channex-webhook-cutover-plan.md) and
[`legacy-historical-binding-preflight.md`](legacy-historical-binding-preflight.md).
Every duration is an estimate until the VAY-1362 rehearsal replaces it with a
measured value. Nothing in this document is an approval: each **[GO]** step
needs an explicit human go on the day._

## Decisions recorded

| Topic                     | Decision (2026-10-08)                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope                     | Cohort-scoped import. Only the reviewed cohort of legacy PMS hotels becomes live target properties; the rest of the legacy estate is not published and gets no owner access. The cohort manifest is reviewed outside the repo. |
| Candidates                | 8 legacy PMS hotels. One with an inactive Channex connection is skipped. One pair of same-name registrations moves as a single hotel, chosen in the rehearsal by which one has bookings.                                       |
| Native lookalikes         | Native Owner properties with similar names are separate businesses; there is no reuse mapping.                                                                                                                                 |
| Owner access              | PMS-only access to the owner's own hotels, no email matching, no automatic Marketplace approval (VAY-2017).                                                                                                                    |
| Fixed-plan Stripe billing | Proposed: stays on legacy through a separate subscription-only Stripe endpoint until billing migrates (VAY-1120). Awaiting confirmation.                                                                                       |
| Rollback window           | Open (proposed: 7 days with legacy read-only).                                                                                                                                                                                 |
| Rollback after reopen     | Open (build reconciliation tooling or accept forward-fix only).                                                                                                                                                                |

## One-writer rule

Exactly one runtime mutates each provider stream, scheduler job or table at
any moment (see the cutover rule in the Channex plan). The order on go-day is:
legacy owns everything → **both frozen** → target imports → target owns.
There is never a step where both write.

These switches are **global**, not per hotel:

| Owner                | Switches                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy `pms-backend` | `PMS_SCHEDULER_ENABLED`, `PMS_LEGACY_{STRIPE,XENDIT,CHANNEX}_WEBHOOK_MODE` (`mutating` / `ack_only_with_receipt` / `proxy_to_target`), `CHANNEX_ADMIN_*_MODE` (`legacy`, `disabled`, `target-owned`, …), `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE`  |
| Target `next-api`    | `PMS_CHANNEX_{BOOKING_SYNC,ARI_SYNC,CONNECTION,PROVISIONING,MARKUPS,MESSAGING,REVIEWS}_MODE`, `CHANNEX_WEBHOOK_INTAKE_MODE`, `STRIPE_WEBHOOK_INTAKE_MODE`, `XENDIT_WEBHOOK_INTAKE_MODE`, the interlock `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned` |

**Never** use `ack_only_with_receipt` as a freeze. It acknowledges provider
events without storing them, so they are lost. During the freeze, legacy
webhooks use `proxy_to_target` with **no** target URL; the handler then answers
`503`, and Stripe retries later. For Channex, the durable buffer is the
**unacknowledged booking-revision feed**: nobody acknowledges revisions during
the window, and the target pulls them once it owns the stream.

## Readiness gate (T-2 days)

1. The rehearsal report is accepted. It includes measured step times, an abort
   drill, and a provider drill on the staging Channex pair.
2. A `target:cutover:dry-run` run completed with parity `GO` and smoke. Its
   report and checksum are the `--approved-run-*` inputs.
3. The cohort manifest is reviewed, and the slug/domain collision pre-check is
   clean against the native properties.
4. Every legacy-sourced cohort property has a historical binding, **or** the
   Channex enable guard is deployed and refuses enable for it.
5. Owners of cohort hotels are notified of the window. OTA closeouts are booked
   whenever the measured window exceeds 2 h (the default assumption).
6. Release freeze: no other next-api, platform or hotel-setup deploy overlaps the
   window. Confirm with the release coordinator.
7. The production backup proof and the target attestation (`vayada_migration_evidence`)
   are prepared for the exact run ID.

## Window

Estimate: 3.5–4.5 h. Every step records evidence in the run's evidence folder.

### F — Freeze both sides (~30 min) **[GO: freeze]**

1. Put the legacy write surfaces (Booking, Marketplace and PMS APIs) behind a
   maintenance page or an ALB write block. The Booking and Marketplace APIs have
   no freeze mode of their own.
2. Legacy `pms-backend` (platform freeze variables), all in one apply:
   - `PMS_SCHEDULER_ENABLED=false`
   - `PMS_LEGACY_CHANNEX_WEBHOOK_MODE=proxy_to_target` and
     `PMS_LEGACY_STRIPE_WEBHOOK_MODE=proxy_to_target`, both with no target URL
     (each answers `503`)
   - `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=disabled` and
     `CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE=disabled`

   `PMS_SCHEDULER_ENABLED=false` does **not** stop two in-process writers that
   start at boot: the promo-usage reconciler (every 15 s) and the fixed-plan
   billing job (every 5 min). Until legacy gains a switch for them, the freeze
   proof must show they wrote nothing during the drain, or `pms-backend` must
   be scaled to zero. If it is scaled to zero, fixed-plan billing pauses for the
   window, so check the billing decision above first.

3. Pause the target's native writers on the tables the imports lock. Domain
   applies abort after 5 s on lock contention, and parity takes `SHARE` locks.
   In practice that means native hotel-setup and PMS write paths go to
   maintenance for the window.
4. Drain: wait two booking-poll intervals plus 10 minutes. Confirm there are no
   in-flight scheduler jobs and that the last-write timestamps are stable.
5. Freeze proof: take manual snapshots of the four legacy databases, record the
   last-write evidence, and compute `--freeze-proof-sha256`.

### M — Extract and import through the orchestrator (~60–90 min) **[GO: cutover]**

1. Create the isolated preprod-labelled source restore and its attestation
   ([extraction](../packages/backend-migration/README.md#immutable-source-extraction)).
2. Run `target:source:extract` with the manifest, the schema revision, the four
   snapshot ARNs and the freeze proof.
3. Run `target:cutover` with production/preprod, the common arguments, the
   backup proof, the approved dry-run report and the approval report. Confirm
   with `PRODUCTION_CUTOVER:<run>:<source-run>`.
   - It runs schema → extraction → identity → catalog (prerequisites → media →
     complete) → booking → pms → marketplace → finance → parity.
   - It pauses at `AWAITING_SMOKE` (exit `4`).
   - Do **not** run the domain CLIs one by one. `target:parity` on its own also
     refuses `--source-env production`; the orchestrator handles the pairing.
4. Exit `2` (no-go) or an unexplained exit `3` → rollback R1.

### S — Smoke (~30 min)

1. For each cohort hotel, check:
   - rooms, rate plans and the availability calendar
   - upcoming and past reservations
   - balances and folios
   - photos
   - the public booking page, on its custom domain where one exists
2. Owner isolation: each owner sees only their own hotels and is refused on
   any other hotel.
3. Native Owner properties are unchanged.
4. Save the `production-cutover-smoke.v1` report and resume the same run with
   `--resume --smoke-report`.

### H — Provider handover (~30 min), strictly in order

1. **[GO: provider apply 1]** Confirm the legacy consumers stay off: scheduler
   off, legacy webhooks `503`, manual syncs `disabled`. Then verify silence for
   two polling intervals.
2. **[GO: provider apply 2]** Set next-api to:
   - `CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE=target-owned`
   - `PMS_CHANNEX_BOOKING_SYNC_MODE=mutating`
   - `CHANNEX_WEBHOOK_INTAKE_MODE=mutating`

   Repoint the Channex webhook URL and the Stripe booking-payment endpoint to the
   target. Change the Stripe endpoint URL in place and keep its signing secret.
   Fixed-plan subscription events follow the billing decision above.

3. Pull the unacknowledged Channex booking revisions once. Stripe's late retries
   are deduplicated by event ID. Reconcile the counts.
4. ARI: run a diff/dry-run of the first availability and rate push first.
   Published offers serve as PMS rate plans (VAY-1422). Only then set
   `PMS_CHANNEX_ARI_SYNC_MODE=mutating`.
5. Airbnb all-hotels (VAY-1551) stays off until day +1.

### O — Reopen **[GO: reopen]**

1. Make the cohort hotels bookable, lift maintenance, and redirect legacy URLs
   and custom domains to the target.
2. Watch for two hours: provider sync errors, duplicate bookings, webhook
   failures, owner support.

## Rollback

**R1 — before reopen.**

- `target:cutover:abort` only marks the run aborted: imported rows stay in the
  target. They must stay unpublished, with no owner access. Defining that state
  (or a cleanup) is preparation work.
- Hand the providers back in reverse order: undo apply 2, then turn the legacy
  scheduler, webhooks and manual syncs back on.
- Lift the maintenance pages. Legacy remains the source of truth.

**R2 — after reopen.** Never restore a backup over new writes. Either
reconcile target writes back into legacy (tooling not built yet) or fix
forward. See the decisions table.

**Triggers:**

- any **[GO]** gate fails
- parity no-go, or an unexplained review result
- an owner can see another hotel
- a provider double-write or a missed booking
- an uncertain dispatch outcome
- an error spike during the watch

## After the window

- Day +1: Airbnb all-hotels (VAY-1551); review replies for the migrated hotels
  (VAY-1532/1533).
- End of the rollback window: acceptance record, then legacy retirement
  (VAY-1363). An archive-restore proof comes before any deletion.

## Open preparation items

- Cohort scope in the migration contract (scope decision above).
- Abort semantics for imported rows (R1).
- Production freeze variables and a protected one-off migration runner
  (platform; inert until go-day).
- Channex enable guard for legacy-sourced properties without a historical binding.
- The rehearsal on an isolated restore of legacy plus a copy of the live target.
