# Legacy fixed-plan billing handover (VAY-1362)

_Design note, 2026-10-08. Maps the fixed-plan billing research breakdown to the
decisions Flamur took on 2026-10-08. Code follows in small stacked PRs; this
note is the contract they implement. It changes no production state._

## Decisions (2026-10-08)

| Topic                         | Decision                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                         | Legacy billing is **frozen before go-day**. The target owns billing **right after the import and before reopen**.                               |
| Stripe objects                | **Keep** the existing subscriptions, customers and cards. No re-checkout, no double charge.                                                     |
| Cycle                         | **Keep the 30-day cycle** for adopted hotels. New target checkouts stay monthly.                                                                 |
| Price                         | **Keep each hotel's current price**, including custom per-hotel prices. The price is never swapped.                                             |
| Dunning                       | When Stripe's retries are exhausted the hotel **reverts to Commission**, as on legacy today.                                                     |
| Outside the cohort            | A live subscription of a hotel outside the migration cohort is **cancelled at period end, with notice** to the hotel.                            |
| Rollback                      | 0-day window. Before reopen adoption is reversible per hotel. After reopen fix forward.                                                          |
| Inventory                     | Two subscriptions exist on the platform account (dashboard). Which hotels, and their status, come from a read-only counts run (human step 0).   |

## One writer at a time

Stripe is the source of truth between owners. A `charge_automatically`
subscription keeps collecting with nobody listening, so the ownerless gap
between the legacy freeze and target adoption is safe. During the gap nothing
syncs room-count prices and nobody emails ops on a failed payment; both are
reconciled from Stripe at adoption.

```
T-7d   legacy FIXED_PLAN_BILLING_MODE=frozen         Stripe = truth
       target acks and ignores unowned events
       Stripe dashboard: six subscription events → target endpoint (human)
T-0    go-day import (cohort)                        Stripe = truth
T-0+   adoption per cohort hotel, before reopen      target = owner
       outside cohort: cancel at period end (human, dashboard)
reopen only after every live subscription is adopted or scheduled to end
```

## Research breakdown → PRs

| Research item                      | Decision applied                                                                            | PR  |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --- |
| 0 read-only inventory              | Human step. The command below never queries production or Stripe on its own.                | —   |
| 1 legacy freeze switch             | `FIXED_PLAN_BILLING_MODE=legacy\|frozen`, default `legacy` (today's behaviour).              | 1   |
| 2 target ignores unowned events    | Legacy-shaped events finish as `ignored_unowned`; no retries, no dead letter.                | 2   |
| 3 adoption command                 | Keeps subscription, customer, price and cycle. Adds target metadata. Writes `fixed`.         | 3   |
| 4 payment-failed ops email         | Ops email and `unpaid` → Commission, **adopted legacy subscriptions only**.                  | 4   |
| 5 Stripe dashboard event mask      | Human go-day step, documented in the runbook. Never done by an agent.                        | 6   |
| 6 migration: billing events table  | Hash-only `omitted_row` disposition instead of a blocker. Tiny change on `main`.             | 5   |
| 7 docs                             | Runbook billing steps, this note, route-contract wording.                                    | 6   |
| 8 (optional) hide legacy UI button | Not done. Frozen legacy answers `409` with a clear message instead.                          | —   |
| G3 cadence, G4 price               | Resolved by "keep": the target accepts a retained legacy 30-day flat price (see below).      | 3   |
| G7 dunning end state               | Resolved: `unpaid` reverts adopted hotels to Commission.                                     | 4   |
| G9 non-cohort subscriptions        | Human dashboard step: cancel at period end, then notify the hotel. Two subscriptions exist.  | 6   |

## 1. Legacy freeze (`apps/pms-api`)

`FIXED_PLAN_BILLING_MODE` is read once at startup like the other cutover
switches. `frozen` means:

- the five-minute billing scheduler is not started and `sync_*` helpers return
  without touching Stripe or the database; room and room-type writes no longer
  trigger an inline price sync (the dirty flag may still be set by the SQL
  triggers; nothing consumes it);
- `POST /webhooks/stripe` skips the fixed-plan branch entirely, including the
  Stripe read it makes today to classify an event. Subscription events fall
  through to the ordinary cutover-mode guard like any other event;
- `POST /admin/billing/fixed-checkout` and `POST /admin/billing/cancel` answer
  `409` with "Fixed-plan billing is moving to the new platform; contact Vayada
  support";
- `GET /admin/billing/subscription` is read-only: it no longer syncs the price
  on read. `POST /admin/billing/portal` keeps working so a hotel can still see
  invoices and update a card.

Switching back to `legacy` restores today's behaviour. This removes billing
from the runbook's "two in-process writers" caveat.

## 2. Target ignores unowned events (`apps/api`)

The job `finance.subscription-webhook` throws today when no entitlement
matches, which retries the job until dead letter. New rule: when no entitlement
matches **and** the event carries no `vayada_organization_id`, the job finishes
as `ignored_unowned`. The receipt in `platform.external_webhook_events` is kept.
Events that carry target metadata but match no entitlement still throw, because
that is a real inconsistency.

Webhook intake itself (`routes/providerWebhooks.ts`, `platform.external_webhook_events`,
`finance.payments`) is not touched.

## 3. Adoption (`apps/api` CLI, dry-run by default)

Per cohort hotel, after the import and before reopen. Legacy hotel ID equals the
target property ID (VAY-2017).

Stripe side, one metadata update per subscription, idempotent:

| Key                        | Value                               |
| -------------------------- | ----------------------------------- |
| `vayada_property_id`       | property ID                         |
| `vayada_organization_id`   | organization ID from the entitlement |
| `vayada_plan`              | `fixed`                             |
| `vayada_legacy_adoption`   | `v1`                                |

`hotel_id` and `vayada_payment_kind=fixed_plan` stay for audit. The item, price,
quantity (1) and billing cycle are untouched, so no invoice is created.

Target side, `finance.billing_entitlements` for the property:

| Column                           | Value                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| `plan_key` / `billing_status`    | `fixed` / `active` (`past_due` when Stripe says `past_due`)          |
| `billing_provider`               | `stripe`                                                             |
| `billing_customer_ref` / `billing_subscription_ref` | from Stripe                                      |
| period columns, `cancel_at_period_end` | from Stripe (item-level period)                               |
| `billing_amount_minor`           | the retained price: `unit_amount × quantity`                         |
| `active_room_count`              | target room inventory                                                |
| `last_provider_event_created_at` | adoption time, so older queued events are stale                      |
| `entitlement_metadata`           | `planSelectedBy: legacy-adoption`, `legacyAdoptedAt`, `providerReentryRequired: false` |

Verification: the target's subscription snapshot check (`fixedPlanVerified`)
learns a third shape next to the monthly and 30-day tiered prices: a **retained
legacy price**, which is a per-unit price, every 30 days, quantity 1, on a
subscription whose metadata carries the four keys above plus the legacy
`hotel_id` equal to `vayada_property_id`. For this shape the snapshot also
carries `amountMinor` and a `retainedLegacyPrice` flag:

- the store writes `amountMinor` instead of the catalog amount, so the plan page
  shows the hotel's real price;
- `invoice.upcoming` does **not** push the room count into the Stripe quantity.
  A flat price with quantity 5 would multiply the charge. Room changes do not
  change an adopted hotel's price; a reprice is a human decision.

Preconditions the command checks before `--apply`: the entitlement exists and
its organization is `active`; the Stripe subscription is `active`, `past_due`
or `trialing`, has one item, and its metadata names this hotel. Already-adopted
hotels are reported and left alone. Adoption is refused inside the 24 hours
before `current_period_end`.

Second mode, `clear-stale-reference`: a cohort hotel that only has a stale
legacy billing reference (an abandoned checkout) arrives as a suspended,
provider-free Commission entitlement. The mode searches Stripe for a live
subscription of the hotel, refuses when one exists, and otherwise sets the
entitlement back to active Commission.

Hotels **outside the cohort** are not imported, so there is nothing to adopt.
Their subscriptions are cancelled at period end in the Stripe dashboard and the
hotel is notified by a human. The frozen legacy `cancel` route cannot do it.

Reversal before reopen: remove the four metadata keys in the dashboard and set
the entitlement back to suspended Commission. After reopen fix forward.

## 4. Failed payment and dunning (`apps/api`)

For entitlements adopted by this command only:

- `invoice.payment_failed` keeps the plan on Fixed and emails Vayada ops
  (`FINANCE_BILLING_OPS_EMAIL` through the existing Resend delivery). Native
  target subscriptions keep today's behaviour (durable job, log line).
- a subscription that reaches `unpaid` (retries exhausted) reverts the
  entitlement to Commission, as legacy did. The Stripe subscription itself is
  left for the operator, also as legacy did.

This touches `finance.billing_entitlements` only. `identity.product_entitlements`
semantics are unchanged.

## 5. Migration exception (`packages/backend-migration`)

`pms.stripe_billing_webhook_events` rows are legacy event-claim bookkeeping.
Today each row is a hard blocker (`UNOWNED_PROVIDER_EVENT`). They become a
hash-only `omitted_row` disposition with reason
`LEGACY_BILLING_PROVIDER_REFERENCE_QUARANTINED`, so the table never blocks the
run and every row is still accounted for. Nothing else in the Finance plan
changes: legacy Fixed hotels still land as suspended Commission until adoption.

## 6. Go-day steps (runbook)

- Before go-day: deploy PR 1 and set `FIXED_PLAN_BILLING_MODE=frozen` on
  legacy; deploy PRs 2–4 on the target; **human**: in the Stripe dashboard add
  `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
  `invoice.upcoming`, `customer.subscription.updated` and
  `customer.subscription.deleted` to the target `/webhooks/stripe` endpoint and
  confirm the legacy endpoint does not subscribe to them.
- After the import, before reopen: run the adoption command in dry run, review,
  then `--apply` per cohort hotel; run `clear-stale-reference` for cohort hotels
  with only a stale reference; cancel non-cohort subscriptions at period end in
  the dashboard and notify those hotels.
- Reopen gate: every live legacy subscription is adopted or scheduled to end.

## Out of scope

- Moving adopted hotels to calendar-month billing or to the catalog price.
- Hiding the Fixed-plan button on the pinned legacy booking-admin build.
- Automating the Stripe dashboard changes or the hotel notices.
