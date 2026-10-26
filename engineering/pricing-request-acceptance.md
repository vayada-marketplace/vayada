# Request-mode acceptance for pricing-v2 quotes (VAY-2099)

_Design note, 2026-10-10. Builds on [replacement booking acceptance](replacement-booking-acceptance.md),
[card acceptance](pricing-card-acceptance.md) and the
[acceptance-mode contract](booking-acceptance-mode-contract.md)._

A request-mode hotel (`booking.booking_settings.acceptance_mode = 'request'`) confirms every
booking itself; the quote freezes the mode. Legacy (`apps/pms-api`) is the reference: rooms are
held while the request waits, the hotel has 24 hours, and the guest and the hotel are emailed.
Everything sits behind `REPLACEMENT_PRICING_REQUEST_ACCEPTANCE_ENABLED` (default `false`); while
it is off a request quote answers 404 `REQUEST_ACCEPTANCE_UNAVAILABLE` and booking-web says
requests can't be sent online yet.

## Pay at property

| Step                    | Where                                       | Effect                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest sends the request | `writePricingAcceptance`                    | Booking `pending_payment` with `hostResponseDeadlineAt` (24 h), rooms held (Channex availability drops), acceptance row and receipt stored, `request_received` (guest) and `host_review_required` (hotel). No revenue, no PMS job. Answer `kind: "requested"`. |
| Hotel accepts           | PMS accept command → `acceptPricingRequest` | Before the deadline only. `confirmed` (`guest_booking.accepted`), room-night revenue from the stored quote, `booking_accepted`, accepted-pricing PMS job (adoption requires `confirmed`). Inventory unchanged.                                                 |
| Hotel declines          | host-actions `reject`                       | Releases the reservation bundle, `declined`, `booking_rejected`.                                                                                                                                                                                               |
| No answer               | pending-booking sweep                       | At the deadline: `expired`, bundle released, `booking_expired` (guest), `host_request_expired` (hotel).                                                                                                                                                        |
| Guest withdraws         | `/withdraw`                                 | `canceled`, bundle released.                                                                                                                                                                                                                                   |

Accept takes only the booking row lock (it changes no inventory), the lock decline, expiry and
withdraw take first, so these cannot deadlock.

## Card

As legacy: a manual-capture PaymentIntent, a direct charge on the hotel's connected account
(`Stripe-Account`, `application_fee_amount`), captured when the hotel accepts and canceled on
decline or expiry. Needs the card switch too. Booking-web says the card is authorised now and
charged only if the hotel accepts (legacy said "charged now").

- Accept with card: `pending_payment` on the 30-minute payment deadline only; no host deadline
  until Stripe authorises, so an unpaid request never holds rooms for 24 h.
- Authorised (`requires_capture`): recorded by the guest's confirm call, by an acceptance retry
  after a lost confirmation, or by the payment-deadline sweep if the guest left. Payment and
  booking `authorized`, `hostResponseDeadlineAt` = now + 24 h, `payment_authorized` sends the
  request emails. The 24 h sit well inside the card hold (about 5–7 days).
- Hotel accepts: the stored quote and amounts are checked and the payment row locked first; the
  hold must be the booking's own for its exact amount; then capture (idempotency key per command)
  and confirm under the booking row lock only. Stripe's capture webhook settles inventory lock
  first, waits, and finds the booking settled. A hold Stripe will not capture leaves the request
  for the expiry sweep. A capture made outside Vayada settles as the hotel's acceptance.
- Decline voids the hold (`financeHostBookingPayments`); an unanswered request is voided and
  expired by the authorised-request sweep.

## Differences from legacy (reviewed with Flamur, 2026-10-10)

The physical room is assigned at accept, not at request; room-type availability is held either
way. The hotel and ops are not emailed about the hotel's own accept or decline; the hotel is
emailed when a request expires. Guests cannot edit a pending request, as in legacy. Legacy
requests still pending at the freeze are resolved in legacy first (VAY-1362 runbook), because
migrated rows carry no request deadline.
