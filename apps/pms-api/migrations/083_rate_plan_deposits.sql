-- Per-rate-plan deposits for direct bookings.
--
-- room_types.rate_deposit_settings shape:
-- {
--   "flexible": {"enabled": true, "percentage": 50},
--   "nonrefundable": {"enabled": true, "percentage": 100}
-- }
--
-- Deposit values are snapshotted onto bookings at creation time so later
-- rate-plan edits do not rewrite existing guest payment terms.

ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS rate_deposit_settings JSONB;

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS deposit_required BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS deposit_percentage INTEGER,
    ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(10,2);

UPDATE bookings
SET balance_amount = total_amount
WHERE balance_amount IS NULL;

ALTER TABLE bookings ALTER COLUMN balance_amount SET NOT NULL;

ALTER TABLE bookings ADD CONSTRAINT bookings_deposit_consistency_check
    CHECK (NOT deposit_required OR (deposit_percentage IS NOT NULL AND deposit_percentage BETWEEN 1 AND 100) OR deposit_amount > 0);

ALTER TABLE bookings
    ADD CONSTRAINT bookings_deposit_percentage_check
        CHECK (deposit_percentage IS NULL OR deposit_percentage BETWEEN 1 AND 100),
    ADD CONSTRAINT bookings_deposit_amount_check
        CHECK (deposit_amount >= 0),
    ADD CONSTRAINT bookings_balance_amount_check
        CHECK (balance_amount >= 0);

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS payment_purpose TEXT NOT NULL DEFAULT 'booking';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IN (
        'card', 'pay_at_property', 'xendit',
        'cash', 'bank_transfer', 'manual_card', 'other'
    ));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_check
    CHECK (payment_method IN ('card', 'pay_at_property', 'xendit', 'bank_transfer'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check
    CHECK (payment_status IN ('unpaid', 'authorized', 'captured', 'cancelled',
                              'refunded', 'partially_refunded', 'failed',
                              'pay_at_property', 'awaiting_transfer'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_purpose_check
    CHECK (payment_purpose IN ('booking', 'deposit', 'balance', 'arrival_charge'));
