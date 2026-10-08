# Card payment for replacement-pricing quote acceptance (VAY-1543 slice C.3)

_Design note, 2026-10-08. Instant bookings only; request-mode (manual capture)
follows later. Everything stays behind `REPLACEMENT_PRICING_CARD_ACCEPTANCE_ENABLED`
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
   `paymentMethod: "card"`, `acceptanceMode: "instant"`). In one transaction:
   the same prepare/lock steps as today, then reserve inventory, insert the
   booking as `draft` / `unpaid` with expected method `card` and
   `metadata.draftExpiresAt` (30 minutes, picked up by the existing
   expired-draft sweep), insert `finance.payments` (`requires_action`,
   amount = `dueNowMinor`, fee from the billing plan on that amount), and
   create the PaymentIntent on the connected account with an idempotency key
   derived from property + acceptance request id. The response is
   `payment_required` with `clientSecret`, `stripeAccountId` and the booking id.
   No acceptance row, revenue, notification or PMS job yet.
2. **Browser** confirms with the existing `StripeProvider` /
   `StripeConfirmStep` (`confirmPayment`, `redirect: "if_required"`).
3. **Confirm payment** (`POST …/quotes/:quoteId/accept/payment`, same
   idempotency key). Lock booking and payment, retrieve the intent, require
   `succeeded`, amount = `dueNowMinor`, currency, account and
   `vayada_booking_reference` metadata. Then run the existing post-confirmation
   steps for the replacement path (status `confirmed`, payment `paid` or
   partially paid when `dueLaterMinor > 0`, revenue, notifications, PMS
   accepted-pricing job, acceptance row). Idempotent: a second call returns the
   stored acceptance.
4. **Webhook** `payment_intent.succeeded` for a booking created by step 1 runs
   the same function as step 3; the legacy settlement must skip these bookings.
5. **Expiry**: the existing sweep cancels the intent (or settles it through
   step 3 if it already succeeded) and releases inventory.

## Pull requests

| PR             | Content                                                              |
| -------------- | -------------------------------------------------------------------- |
| K1 api         | switch + accept-with-card (step 1) + `.postgres` tests               |
| K2 api         | confirm payment (step 3) + replay/idempotency + `.postgres` tests    |
| K3 api         | webhook and expiry routing (steps 4–5), legacy settlement guard      |
| K4 booking-web | card choice on the quote, Stripe step, confirm call; mocked e2e      |
| K5 ops         | Stripe test-mode run on a test hotel; then the switch, human go only |
