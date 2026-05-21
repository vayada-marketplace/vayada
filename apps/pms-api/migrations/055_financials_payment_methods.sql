-- Migration 055: Manual payments for the Financials section
-- Lets hotel staff record offline payments (cash, bank transfer, manual card swipe, …)
-- against an invoice (= booking) from the new PMS Financials UI.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IN (
        'card', 'pay_at_property',
        'cash', 'bank_transfer', 'manual_card', 'other'
    ));

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reference TEXT,
    ADD COLUMN IF NOT EXISTS recorded_by UUID;
