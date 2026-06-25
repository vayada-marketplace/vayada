# Xendit webhook strategy

_VAY-840 recommendation. This is planning only: no handlers, provider
secrets, Terraform, or replay execution are changed here._

## Recommendation

Use Xendit only as a planned target Booking/Finance provider until real
production or staging dashboard/runtime configuration is confirmed. The legacy
PMS code can create Xendit invoices and payouts, but the VAY-794 evidence says
no real `XENDIT_SECRET_KEY` or production `XENDIT_WEBHOOK_SECRET` was found in
the deployed runtime namespace, and only a generated staging replay placeholder
existed. Do not configure production Xendit callbacks as live mutating traffic
until secrets, dashboard URLs, and a replay rehearsal exist.

When Xendit is activated, keep one Finance-owned provider intake for Xendit and
split only the domain effects:

- Booking payments use Xendit Invoice/Payment Link callbacks for hosted guest
  checkout payment status.
- Finance payouts use Xendit Payout callbacks as the primary status source.
- Finance payout polling/manual reconciliation remains as a fallback job, but
  only in the single runtime that owns payout status mutation. No legacy/target
  dual polling.

This keeps Xendit callback token verification, raw receipt storage, replay, and
dead-letter handling in one intake path while letting Booking own guest booking
lifecycle effects and Finance own settlement, payout, and reconciliation state.

## Official Xendit facts used

- Xendit sends webhook authentication in the `x-callback-token` header and
  recommends verifying it server-side before acting on a webhook:
  [Handling webhooks](https://docs.xendit.co/docs/handling-webhooks).
- Webhook URLs are configured in the Xendit dashboard's webhook settings, and
  delivery is by HTTP POST to the saved endpoint:
  [Webhook behavior](https://docs.xendit.co/apidocs/webhook-behavior).
- Xendit retries failed webhook deliveries up to six times over roughly 24
  hours and dashboard users can manually resend events:
  [Webhook behavior](https://docs.xendit.co/apidocs/webhook-behavior).
- Payment Link/Invoice API uses `POST /v2/invoices`; the webhook payload
  includes identifiers such as `id`, `external_id`, `status`, amount fields,
  payment method/channel fields, and uses `PAID` and `EXPIRED` lifecycle
  states:
  [Payment Links API overview](https://docs.xendit.co/docs/payment-links-api-overview).
- Payout API `POST /v2/payouts` requires an `Idempotency-key`, accepts a
  merchant `reference_id`, returns an initial accepted payout, and expects the
  final result from callback/status lookup:
  [Create a Payout](https://docs.xendit.co/apidocs/create-payout).
- Xendit's v2 Payout integration lists `payout.succeeded`, `payout.failed`,
  and `payout.reversed` events mapped to `SUCCEEDED`, `FAILED`, and `REVERSED`:
  [Payouts](https://docs.xendit.co/docs/integration-payouts).
- Xendit also documents a v3 payout webhook with `v3_payout.*` events and
  `data.payout_id`; Vayada should not enable that shape until the target parser
  supports it:
  [Payout Webhook](https://docs.xendit.co/apidocs/payout-v3-webhook).
- Payments API v3 has payment events such as `payment.capture`,
  `payment.authorization`, and `payment.failure`; those are not the same
  contract as current Invoice/Payment Link callbacks:
  [Payments API webhooks](https://docs.xendit.co/docs/payments-api-webhooks).

## Current Vayada state

Legacy PMS `POST /webhooks/xendit` in
`apps/pms-api/app/routers/webhooks.py` verifies `x-callback-token` against
`XENDIT_WEBHOOK_SECRET`, then handles two payload shapes:

- Invoice callbacks: top-level `id`, `external_id`, `status`, and no `event`.
  `PAID` marks the payment captured and updates Booking payment/lifecycle
  state; `EXPIRED` cancels the payment and booking.
- Payout callbacks: `event` plus `data.id` and `data.status`. Succeeded marks
  the payout completed; failed marks it failed; affiliate success may send an
  affiliate payout notification inline.

Legacy PMS also has:

- `process_property_payouts` and `process_affiliate_payouts`, which can create
  Xendit payouts and leave rows in `processing`;
- `poll_xendit_processing_payouts`, which polls stale processing payouts as a
  fallback;
- `POST /admin/xendit/reconcile-payouts`, guarded by
  `FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE`.

Target `apps/api` already has generic provider webhook intake for Xendit in
`apps/api/src/routes/providerWebhooks.ts`. It verifies the same
`x-callback-token`, supports `observe_only`, `mutating`, and
`ack_only_with_receipt`, persists receipts through
`platform.external_webhook_events`, and creates Finance webhook jobs. Current
target classification handles Invoice/Payment Link payloads and v2-style payout
payloads with `data.id`; it does not yet handle v3 payout `data.payout_id`.

## Selected and deferred callbacks

| Surface                                           | Decision         | Xendit event/config                                                                     | Target owner                                      | Notes                                                                                                                                                                             |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking guest checkout through hosted Xendit page | Select           | Invoice/Payment Link callback for invoice paid and expired states                       | Finance intake; Booking lifecycle jobs            | Matches current `/v2/invoices` integration. Use invoice `id`, `external_id`, `status`, `paid_amount`/`amount`, `currency`, `payment_id`, `payment_method`, and `payment_channel`. |
| Finance property payouts                          | Select           | v2 Payout callbacks: `payout.succeeded`, `payout.failed`, `payout.reversed`             | Finance                                           | Status callbacks are primary. Payout dispatch must be target-owned before target mutates callbacks.                                                                               |
| Finance affiliate payouts                         | Select           | Same v2 Payout callbacks                                                                | Finance plus marketplace/affiliate resource links | Finance owns payout status and provider refs; marketplace/affiliate owns affiliate identity and notification/audit visibility.                                                    |
| Payout polling/manual reconciliation              | Keep as fallback | No dashboard callback; target Finance job                                               | Finance                                           | Active only in one runtime. Disable legacy `poll_xendit_processing_payouts` and legacy manual reconcile before target payout reconciliation can mutate.                           |
| Xendit v3 Payout webhook                          | Defer            | `v3_payout.succeeded`, `v3_payout.failed`, `v3_payout.reversed`                         | Finance later                                     | Current parser expects `data.id`; v3 sends `data.payout_id`. Add compatibility before enabling v3.                                                                                |
| Payments API v3 payment webhooks                  | Defer            | `payment.capture`, `payment.authorization`, `payment.failure`, `payment_request.expiry` | Booking/Finance later                             | Enable only if Booking creates Payment Requests/Sessions instead of Invoice/Payment Links. Do not mix with Invoice callbacks for the same checkout flow.                          |
| Refund webhooks                                   | Defer            | `refund.succeeded`, `refund.failed`                                                     | Finance later                                     | No current Xendit refund flow is in scope for Booking payments or payout reconciliation.                                                                                          |

## Dashboard and secrets

Configure Xendit callbacks per environment only after the target endpoint and
secrets exist:

1. In Xendit dashboard Webhook Settings, configure the Invoice/Payment Link
   callback URL and the Payout callback URL. They may point to the same Vayada
   route, `POST /webhooks/xendit`, because the payload shape distinguishes
   invoice from payout.
2. Use environment-specific public HTTPS URLs. For target-owned runtime, use
   the target API URL. During old-URL drain, keep the legacy URL reachable only
   in `ack_only_with_receipt` or `proxy_to_target`.
3. Store the dashboard webhook verification token as `XENDIT_WEBHOOK_SECRET`
   for the runtime receiving callbacks. This is not the same as
   `XENDIT_SECRET_KEY`.
4. Store `XENDIT_SECRET_KEY` only for server-side Xendit API calls: creating
   invoices/payouts, bank validation, and payout status polling. Receive-only
   webhook intake does not need the API secret.
5. Before switching production, export the dashboard callback URLs, enabled
   events, token ownership, and test callback result. Do not print token values
   in docs or tickets.
6. Because Xendit retries failed deliveries for roughly 24 hours, keep the old
   URL reachable for the repo's existing 72-hour provider drain window unless
   dashboard retry history proves there are no pending retries.

Token behavior:

- Reject missing or mismatched `x-callback-token` before writing receipts or
  mutating state.
- Compare tokens with constant-time comparison.
- Current legacy and target handlers accept a single `XENDIT_WEBHOOK_SECRET`.
  Do not rotate an active dashboard token by replacing runtime secrets first;
  old-token callbacks would be rejected until the dashboard is updated.
- For zero-downtime rotation or proxy drain, add current/next token acceptance
  to every receiving runtime and prove forwarded callbacks use a token accepted
  by the target. Without dual-token support, rotation is a planned maintenance
  action: pause provider switch work, update the dashboard token and runtime
  secret as one change, send the dashboard test callback, then reconcile any
  retries.

## Payload identifiers

Invoice/Payment Link payloads should carry enough identifiers to avoid lookup by
guest PII:

- Xendit invoice id: `id`.
- Merchant reference: `external_id`, currently generated like
  `booking-<bookingId>` in legacy.
- Target metadata on newly created invoices: `guestBookingId`, `propertyId`,
  `paymentId`, and `bookingReference` when available.
- Status and amount: `status`, `amount`, `paid_amount`, `currency`.
- Payment rail details for receipts/support: `payment_id`, `payment_method`,
  `payment_channel`, and `paid_at` when present.

Payout creation should persist both Vayada and Xendit identifiers:

- Xendit payout id: response `id`; callback `data.id` for v2, or
  `data.payout_id` if v3 is later enabled.
- Xendit `reference_id`: set from the Vayada payout id, e.g.
  `hotel-<payoutId>` / `affiliate-<payoutId>` while legacy compatibility
  remains, or `xendit-payout:<ownerScope>:<payoutId>:v1` in target-only code.
- Xendit create-payout `Idempotency-key`: stable per Vayada payout attempt and
  under Xendit's 100-character limit, preferably
  `xendit-payout:<ownerScope>:<payoutId>:v1`.
- Store `failure_code`, provider status, and the last provider payload hash in
  Finance payout metadata/audit, not in Booking or Marketplace tables.

## Target idempotency keys

Use raw receipt keys for provider delivery dedupe, semantic domain event keys
for business effect dedupe, and job keys for asynchronous work. Raw receipt
dedupe alone is not enough.

| Effect                                | Key                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Invoice raw receipt                   | `webhook:xendit:invoice:<callback_id-or-invoice_id>:<status>`                      |
| Payout raw receipt                    | `webhook:xendit:payout:<payout_id>:<status>`                                       |
| Unknown payout fallback               | `webhook:xendit:payout:unknown:<sha256(canonical_payload)>`                        |
| Payment captured                      | `payment.captured:xendit:<invoice_id>:<paid_amount-or-amount>:v1`                  |
| Payment terminal                      | `payment.terminal:xendit:<invoice_id>:<status>:v1`                                 |
| Payout status                         | `payout.status:xendit:<payout_id>:<status>:v1`                                     |
| Payment reconcile job                 | `payment.reconcile-status:payment:<invoice_id>:xendit-status-<status>:v1`          |
| Booking instant finalize job          | `booking.finalize-instant:booking:<booking_id>:xendit-invoice-<invoice_id>:v1`     |
| Booking invoice-expired job           | `booking.payment-expired:booking:<booking_id>:xendit-invoice-<invoice_id>:v1`      |
| Guest payment email job               | `email.payment-confirmed:booking:<booking_id>:guest:v1`                            |
| Host request notification job         | `email.booking-requested:booking:<booking_id>:host:v1`                             |
| Payout reconcile job                  | `finance.reconcile-payout:payout:<payout_id>:xendit-status-<status>:v1`            |
| Manual/poll payout reconciliation job | `finance.reconcile-payout:property:<property_id>:xendit-manual-<window>:v1`        |
| Property payout dispatch job          | `finance.dispatch-property-payout:property:<property_id>:payout:<payout_id>:v1`    |
| Affiliate payout dispatch job         | `finance.dispatch-affiliate-payout:affiliate:<affiliate_id>:payout:<payout_id>:v1` |

Current target code uses `payment.reconcile-status:payment:<invoice_id>:xendit-invoice-<invoice_id>:v1`
for Xendit invoice jobs. Before mutating production callbacks are enabled, change
that job key to include status as shown above so paid and terminal callbacks for
the same invoice cannot collapse onto one job key.

## Legacy `/webhooks/xendit` behavior by mode

| Cutover phase/mode          | Legacy behavior                                                                                                                                                                          | Recommendation                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target `observe_only` phase | Legacy stays `mutating` if a real Xendit production callback is active; target receives only mirrored/synthetic/shadow traffic.                                                          | Do not add a separate legacy observe-only mode unless the provider can only point at legacy and a durable receipt store is added there.                                                                                 |
| `mutating`                  | Legacy verifies token and mutates payments, bookings, payouts, and notifications inline.                                                                                                 | Allowed only before target owns the callback and only if target is not mutating the same provider events.                                                                                                               |
| `ack_only_with_receipt`     | Legacy verifies token, computes `legacy:xendit:<sha256(payload)>`, returns 2xx, and does not mutate. The receipt is returned/logged but not durably persisted.                           | Use for short old-URL drain only when the target already has the receipt from another path. Prefer `proxy_to_target` for real callback delivery because current legacy ack-only can otherwise lose replayable payloads. |
| `proxy_to_target`           | Legacy verifies token, forwards raw request body/headers to the configured target URL, and does not mutate locally.                                                                      | Preferred old-URL drain mode after target owns Xendit. Let target write the durable receipt; return non-2xx if target rejects so Xendit retries.                                                                        |
| Rollback                    | Dashboard is repointed to legacy, target mode returns to `observe_only` or is disabled, and legacy returns to `mutating` only after target jobs are stopped and receipts are reconciled. | For payouts, stop target reconciliation/dispatch first; re-enable legacy `poll_xendit_processing_payouts` or manual reconcile only for payouts without successful target provider effects.                              |

Legacy `POST /admin/xendit/reconcile-payouts` follows
`FINANCE_XENDIT_PAYOUT_RECONCILIATION_LEGACY_MODE`:

- `legacy-owned`: route may poll and mutate legacy payout status.
- `disabled` / `target-owned`: route returns `423` before polling.
- `proxy-to-target`: route sends an idempotent target Finance reconcile command.

Use `disabled`, `target-owned`, or `proxy-to-target` before target Finance
payout reconciliation can mutate status.

## Activation path

1. Confirm product intent: Xendit is either activated for specific Booking
   properties/regions and Finance payout methods, or remains disabled.
2. Confirm provider ownership: one environment-specific Xendit dashboard owner
   exports Invoice/Payment Link and Payout callback configuration.
3. Wire secrets only after ownership is confirmed:
   `XENDIT_WEBHOOK_SECRET` for callback intake, `XENDIT_SECRET_KEY` for API
   calls.
4. Deploy target intake in `observe_only`, replay official/sandbox fixture
   callbacks twice, and prove one raw receipt per event.
5. Freeze legacy payout polling and manual reconcile for the affected scope.
6. Switch Invoice/Payment Link callbacks first if Booking Xendit payments are
   in scope; then switch Payout callbacks after Finance reconciliation views
   are ready.
7. Put legacy `/webhooks/xendit` in `proxy_to_target` for the 72-hour drain.
8. Enable target payout polling/manual reconciliation only after target payout
   webhook status handling is live and legacy polling is off.

## Follow-up tickets

1. **Confirm Xendit production/staging provider ownership and runtime status**
   - Export dashboard callback URLs, enabled events, environment, token owner,
     and whether any real Booking or Finance flow currently uses Xendit.
2. **Wire Xendit provider secrets through platform runtime**
   - Add `XENDIT_WEBHOOK_SECRET` and `XENDIT_SECRET_KEY` only after owner
     confirmation; include rotation and dashboard test evidence.
3. **Harden target Xendit webhook parsing before mutating enablement**
   - Support `payout.reversed`; support v3 `data.payout_id` only if v3 is
     selected; update Xendit invoice job key to include status; add replay
     fixtures for paid, expired, succeeded, failed, and reversed.
4. **Add dual-token Xendit webhook verification for rotation/drain**
   - Accept current and next callback tokens in legacy and target runtimes,
     verify constant-time comparison for both, and add proxy-drain replay tests
     proving legacy-forwarded callbacks are accepted by target before removing
     the old token.
5. **Implement target Booking effects for Xendit invoice callbacks**
   - Convert paid/expired invoice callbacks into Finance payment events plus
     Booking lifecycle/email jobs with the keys listed above.
6. **Implement target Finance payout status reconciliation**
   - Handle payout success/failure/reversal, failure codes, dead letters,
     reconciliation views, and fallback polling without legacy dual mutation.
7. **Decide legacy ack-only durability**
   - Either persist legacy ack-only receipts durably or document
     `proxy_to_target` as mandatory for real old-URL drain.
8. **Run Xendit staging replay**
   - Use real test-mode dashboard callbacks and token, not only synthetic
     fixture payloads; record receipt, domain event, job, dedupe, and dashboard
     retry evidence.

## Residual risk

- The current recommendation depends on VAY-794 evidence that real Xendit
  runtime configuration is absent. If a separate dashboard/runtime outside the
  checked evidence is active, this document must be updated before any switch.
- Target `apps/api` has intake scaffolding, but the domain handlers/jobs for
  Booking and Finance effects still need implementation before `mutating` is
  safe.
- Current legacy ack-only mode is not a durable receipt store. Do not rely on it
  as the only recipient of a real Xendit callback that must be replayed later.
