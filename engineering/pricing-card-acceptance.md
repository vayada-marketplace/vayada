# Card payment for replacement-pricing quote acceptance (VAY-1543 slice C.3)

_Design note, 2026-10-08. Instant bookings; request mode (manual capture) is
described in [request-mode acceptance](pricing-request-acceptance.md). Everything stays behind `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED`
(default `false`) until every step below is merged and verified in Stripe test
mode on a test hotel._

## Why this is not a one-line switch

Pay-at-property acceptance (`writePricingAcceptance`) does everything in one
transaction: reserve inventory, insert the booking as `draft`, flip it to
`confirmed`, write revenue evidence, enqueue notifications, stage the PMS
accepted-pricing reservation job and store the append-only acceptance row.
Eleven checks along that path require `pay_at_property` and `dueNowMinor = 0`.

A card booking must not be confirmed, handed to the PMS or announced until
Stripe reports the money. The old checkout handles that with a `draft` booking,
a `finance.payments` row in `requires_action`, a PaymentIntent on the hotel's
connected account, a browser confirmation (`stripe.confirmPayment`), the
`confirm-authorization` endpoint, the `payment_intent.succeeded` webhook and an
expiry sweep. Those pieces assume the old model: they charge
`booking.totalAmount` (a card quote's `dueNowMinor` can be lower when some
charges are collected at the property), and settlement stages the legacy
`pms.reservation.create` job instead of the accepted-pricing job.

## Flow

1. **Accept with card** (`POST …/quotes/:quoteId/accept`, quote
   `paymentMethod: "card"`, `acceptanceMode: "instant"`). One transaction, while
   the quote is still valid (quotes live five minutes; paying can take longer):
   the same prepare/lock steps as today, the booking draft with expected method
   `card`, the lifecycle step reserves inventory and sets the booking to
   `pending_payment` with `metadata.paymentDeadlineAt` (30 minutes), the
   append-only acceptance row and completed command receipt are stored, then
   `finance.payments` (`requires_action`, amount = `dueNowMinor`, fee from the
   billing plan on that amount) and the PaymentIntent on the connected account
   (idempotency key from property + acceptance request id). The response is
   `payment_required` with `clientSecret`, `stripeAccountId` and the deadline. No
   revenue, notification or PMS job yet. A repeated request returns the same
   intent while it still awaits payment.
2. **Browser** confirms with the existing `StripeProvider` /
   `StripeConfirmStep` (`confirmPayment`, `redirect: "if_required"`).
3. **Confirm payment** (`POST …/quotes/:quoteId/accept/payment`). Lock booking
   and payment, retrieve the intent, require `succeeded`, amount =
   `dueNowMinor`, currency, account and `vayada_booking_reference` metadata.
   Then: payment `paid`, booking `confirmed` with payment status `paid` (or
   partially paid when `dueLaterMinor > 0`), status event, revenue evidence from
   the stored quote and its calculation, guest/host notifications and the PMS
   accepted-pricing job. Idempotent.
4. **Webhook** `payment_intent.succeeded` for these bookings runs step 3; the
   legacy settlement must skip them.
5. **Expiry**: after `paymentDeadlineAt` a sweep cancels the intent (or runs
   step 3 if it already succeeded), cancels the booking and releases the rooms.
   The acceptance row stays as history.

## Pull requests

| PR             | Content                                                              |
| -------------- | -------------------------------------------------------------------- |
| K1 api         | switch + accept-with-card (step 1) + `.postgres` tests               |
| K2 api         | confirm payment (step 3) + replay/idempotency + `.postgres` tests    |
| K3 api         | webhook and expiry routing (steps 4–5), legacy settlement guard      |
| K4 booking-web | card choice on the quote, Stripe step, confirm call; mocked e2e      |
| K5 ops         | Stripe test-mode run on a test hotel; then the switch, human go only |
