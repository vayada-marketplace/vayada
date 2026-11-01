-- VAY-2442 P3. What Vayada owes each hotel for vayada Payment, as money events that are never
-- changed or deleted. A paid card charge adds the guest's payment less Vayada's fee; refunds,
-- disputes, payouts and returned payouts (later parts) add their own rows. A hotel's balance in a
-- currency is the sum of net_minor; source_key makes each event count once. Amounts are minor
-- units of the stay's currency, which is what the hotel is owed in (Vayada carries the exchange).
CREATE TABLE finance.hotel_payout_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'charge', 'refund', 'dispute', 'dispute_reversal', 'payout', 'payout_returned', 'adjustment'
  )),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor BIGINT NOT NULL,
  fee_minor BIGINT NOT NULL,
  net_minor BIGINT NOT NULL,
  guest_booking_id UUID,
  payment_id UUID,
  -- The stay's check-out date: payouts cover stays that checked out by the cut-off.
  stay_check_out DATE,
  source_key TEXT NOT NULL UNIQUE CHECK (length(source_key) BETWEEN 1 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (net_minor = gross_minor - fee_minor),
  CHECK (entry_kind <> 'charge' OR (
    gross_minor > 0 AND fee_minor BETWEEN 0 AND gross_minor
    AND payment_id IS NOT NULL AND guest_booking_id IS NOT NULL AND stay_check_out IS NOT NULL
  )),
  FOREIGN KEY (payment_id, property_id) REFERENCES finance.payments(id, property_id),
  FOREIGN KEY (guest_booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id)
);
CREATE UNIQUE INDEX hotel_payout_ledger_one_charge_per_payment
  ON finance.hotel_payout_ledger(payment_id) WHERE entry_kind = 'charge';
CREATE INDEX hotel_payout_ledger_balance
  ON finance.hotel_payout_ledger(property_id, currency, stay_check_out);
CREATE TRIGGER hotel_payout_ledger_append_only
  BEFORE UPDATE OR DELETE ON finance.hotel_payout_ledger
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
