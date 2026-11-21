-- VAY-2572. Stripe's "dispute countered fee": charged on Vayada's account when Vayada answers a
-- guest's card dispute, kept when Vayada loses, returned if the loss is overturned. Stripe sends
-- it with no dispute event, so next-api books it on its own ledger lines: 'dispute_fee' (net
-- −fee, taken from the hotel's next payout) when a dispute closes lost after Vayada answered it,
-- and 'dispute_fee_returned' (net +fee) if that dispute's money is later reinstated. Both carry
-- gross 0, so they never change what a payment's refunds and disputes may take.
SET LOCAL lock_timeout = '5s';

ALTER TABLE finance.hotel_payout_ledger
  DROP CONSTRAINT hotel_payout_ledger_entry_kind_check,
  ADD CONSTRAINT hotel_payout_ledger_entry_kind_check CHECK (entry_kind IN (
    'charge', 'refund', 'dispute', 'dispute_reversal', 'payout', 'payout_returned', 'adjustment',
    'dispute_fee', 'dispute_fee_returned'
  )),
  ADD CONSTRAINT hotel_payout_ledger_dispute_fee_shape CHECK (
    entry_kind NOT IN ('dispute_fee', 'dispute_fee_returned') OR (
      gross_minor = 0 AND payment_id IS NOT NULL AND guest_booking_id IS NOT NULL
      AND (entry_kind = 'dispute_fee') = (fee_minor > 0)
      AND (entry_kind = 'dispute_fee_returned') = (fee_minor < 0)
    )
  );
