# Airbnb alteration financial snapshots

VAY-1551, 2026-09-14. Follows `airbnb-alteration-intake.md`.

## Provider evidence

Evan from Channex replied to “Clarification on Airbnb booking amounts and nightly
revenue” on 2026-09-14; Flamur supplied the reply and authorized implementation.
The reply confirms:

- `booking_amount_settings` controls booking, room and nightly amounts. Payout
  Amount already excludes the Airbnb host fee; Total Paid Amount includes commission.
- `ota_commission` is separate evidence, not another deduction from payout amounts.
- `cohost_payout_calculations` can reduce amounts by co-host commission.
- `rooms[].days` contains provider allocations across the whole stay, with rounding,
  rather than actual host calendar prices. Preserve the supplied decimals.
- A modified revision supplies the full updated stay, not changed-night deltas.
- `rooms[].taxes` supplies structured tax/fee amounts and inclusion flags. Notes may
  contain other information; do not parse free text into financial facts.
- Support says booking revisions have no `amount_type`, and structured withheld taxes
  are Booking.com-only. This conflicts with earlier changelog evidence. Neither field
  may establish Airbnb economics until that discrepancy is resolved.

The public [Bookings Collection](https://docs.channex.io/api-v.1-documentation/bookings-collection)
documents the tax fields `total_price`, `is_inclusive` and `type`.

## Adapter contract

Read a scoped modified Airbnb revision into a complete replacement **provider
snapshot**. Validate revision/property/booking/currency/stay/room positions through
the existing nightly-price reader. Require every current night to have a price;
partial financial snapshots cannot become replacement instructions. Preserve explicit
zero, exact supplied strings, room totals, nullable commission and nullable tax lists.
Missing tax lists differ from empty lists; neither proves tax-free room revenue.

The caller supplies the resolved channel setting, never a revision `amount_type`.
Reject unknown amount mode; preserve unknown co-host configuration as null. This
adapter does not prove that a current settings snapshot applied to an older revision:
the future coordinator must establish channel ownership and settings history/freshness.
Do not switch channel configuration or guess a default as part of ingestion.

Do not add/subtract commission or taxes, reconstruct gross room revenue, spread
totals, or retain old nights omitted from the replacement. Ignore guest/card data,
notes, listing pricing `amount_type` and disputed withheld-tax fields.

## Runtime boundary

The adapter is a tested prerequisite, not an activated financial writer. Existing
Booking/Finance correction contracts require gross room revenue; payout/guest totals
cannot be renamed to that field. Worker wiring still needs a basis-aware accounting
contract, source freshness, atomic ledger/commission corrections and payment/folio
handling. Keep the current Finance guard and runtime switches. The real Airbnb test
remains **SKIPPED** under Flamur's waiver; synthetic tests are not provider validation.
