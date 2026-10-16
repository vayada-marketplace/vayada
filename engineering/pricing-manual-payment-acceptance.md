# Bank transfer and PayPal for pricing-v2 quotes (VAY-2139)

_Design note, 2026-10-12. Builds on [replacement booking acceptance](replacement-booking-acceptance.md),
[card acceptance](pricing-card-acceptance.md) and [request-mode acceptance](pricing-request-acceptance.md).
Agreed with Flamur through the VAY-965 coordinator on 2026-10-12._

Bank transfer and PayPal are "manual" methods: the guest pays the hotel directly and the hotel
confirms that the money arrived. PayPal here means "send the amount to the hotel's PayPal
email". There is no PayPal API, webhook or provider account. Bank details live encrypted in
`finance.bank_transfer_destinations`; the PayPal email and window live in
`finance.payment_settings.deposit_policy` (`paypalEmail`, `paypalPaymentWindowHours`, 1–168, default 24).

Everything sits behind `REPLACEMENT_PRICING_MANUAL_PAYMENT_ACCEPTANCE_ENABLED` (default `false`).
While it is off, a bank-transfer or PayPal quote request answers 400, and accepting one answers
404 `MANUAL_PAYMENT_UNAVAILABLE`; a replay of a booking made while it was on still answers its
pending payment. Booking launch readiness keeps counting only card and pay at property, so a
bank-only or PayPal-only hotel cannot publish its booking page. Such a hotel can save and publish
pricing-v2 prices (Finance pricing readiness counts its method), so they also reach channels.

With the switch on, such a hotel can publish: launch readiness, the publication snapshot and the
setup Finance step count an enabled bank destination or a valid PayPal email, only for a hotel
that takes neither card nor pay at property. Turning the switch off again takes those pages down:
the readers of stored booking content (the public profile and the published URL) refuse content
listing bank transfer or PayPal unless they were created with the switch on. Since VAY-2129 the
offer catalog serves the current offers while a publication is live, and quotes refuse bank
transfer and PayPal while the switch is off.

## Flow (the same for both methods and both acceptance modes)

| Step                    | Effect                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote                   | The selected offers must list the method, and Finance must have an enabled bank destination or a valid PayPal email. The full amount is due before the deadline (`dueNow` = total, nothing at the property), like card.                                                                                                                                         |
| Guest books             | Booking `pending_payment`, rooms held, `pendingExpiresAt` = now + 48 h (bank) or + `paypalPaymentWindowHours` (PayPal). The bank destination is bound to the booking. The answer carries a confirmation token, the amount, the reference and the deadline. Guest email with the instructions; hotel email "waiting for payment". No revenue and no PMS job yet. |
| Hotel: payment received | PMS mark-paid, before the deadline only. `confirmed` and `paid` from the stored acceptance: room-night revenue, a manual `finance.payments` row with commission, the accepted-pricing PMS job, guest confirmation and hotel new-booking emails, guest contact unlocked. Inventory unchanged.                                                                    |
| Hotel declines          | Before payment only. Releases the reservation bundle, `declined`, `booking_rejected`.                                                                                                                                                                                                                                                                           |
| No payment              | The pending-booking sweep at `pendingExpiresAt`: `expired`, bundle released, guest and hotel emailed.                                                                                                                                                                                                                                                           |

There is no separate "accept" step for bank transfer (legacy had accept, then 24 h to pay). The
hotel's one manual step is "payment received", in either acceptance mode.

## Pricing evidence stays stable

`lockFinanceReplacementPricingReadiness` returns bank transfer and PayPal next to card and pay at
property, but keeps them out of the `finance.pricing.v2` evidence hash. Hotels that already list
them next to card or pay at property keep their saved prices current when this ships. The bank
destination and PayPal email are checked again at quote and acceptance. Payment settings edits
still stale saved prices through the Finance pricing source, as today. On their own they make
Finance ready only for a hotel that accepts neither card nor pay at property, so a card hotel whose
Stripe readiness lapses still fails as before. Quotes for them must be due in full before the stay
(no charges collected at the property), and bank transfer is quoted only where the bank-details
binding (KMS settings) exists.

## Known gaps

A published bank-only or PayPal-only page records the methods that were ready when it was
published, and disabling the bank details or removing the PayPal email does not bump Finance's
payment methods revision. So the readers of stored booking content (the public profile and the
published URL) serve such a page only while the hotel still takes at least one of its methods with
the details in place. Otherwise the page is hidden, as with the switch off, and it comes back by
itself once the details are restored. Quotes and acceptance check the details too. Restoring a
different PayPal email (or any other payment-settings change) still asks for the prices to be saved
again, as every Finance change does, before guests can book.

The payment deadline is the agreed window (48 h, or the hotel's PayPal window). VAY-2145 makes
sure it ends before the guest arrives:

- Bank transfer is offered only when check-in is at least 48 h away, and PayPal only when check-in is
  further away than its window.
- "Check-in" is the hotel's check-in time on the arrival date in the property time zone, or 00:00
  when none is set.
- The quote refuses a closer stay with 422 `MANUAL_PAYMENT_TOO_SOON`, and acceptance checks again
  (time passes after the quote) and answers `MANUAL_PAYMENT_UNAVAILABLE`.
- The checkout settings give `/book` the earliest arrival date for each method, so it can hide
  them for closer stays.

## Out of scope

A real PayPal integration, cancelling or refunding after a recorded manual payment, recording a
payment after the deadline, collecting commission on manual payments, translated emails, deposits
(pricing-v2 refuses deposit terms) and quotes with charges collected at the property.

## Slices

1. Quote: method types, Finance pricing readiness, payment amounts and the quote switch.
2. Acceptance: pending payment, deadline, hold, bank binding, instructions and emails.
3. Host: payment received, decline before payment, expiry emails.
4. booking-web: method choice, instructions, first-person copy.
5. Readiness (after VAY-2136): domain-finance methods, publication snapshot, setup PUT.
6. Setup and pricing UI: Payments step cards and note, offer-term method pickers.
7. Real-PostgreSQL walk for a bank-only and a PayPal-only hotel.
