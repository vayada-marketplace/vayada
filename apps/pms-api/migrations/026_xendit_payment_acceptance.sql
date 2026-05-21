-- Xendit payment acceptance: allow hotels to accept payments via Xendit Invoice
-- (QRIS, e-wallets, virtual accounts, cards) alongside Stripe

-- Track Xendit invoice ID on payments
ALTER TABLE payments ADD COLUMN xendit_invoice_id TEXT;
ALTER TABLE payments ADD COLUMN xendit_invoice_url TEXT;

-- Enable Xendit payment acceptance per hotel (separate from payout provider)
ALTER TABLE hotel_payment_settings ADD COLUMN xendit_payments_enabled BOOLEAN DEFAULT false;

-- Expand payment_method on bookings to include xendit
-- (Xendit Invoice handles method selection, so we just track 'xendit')
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IN ('card', 'pay_at_property', 'xendit'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_method_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_check
    CHECK (payment_method IN ('card', 'pay_at_property', 'xendit'));
