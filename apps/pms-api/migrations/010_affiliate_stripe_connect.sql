-- Add Stripe Connect fields to affiliates table
ALTER TABLE affiliates
    ADD COLUMN stripe_connect_account_id TEXT,
    ADD COLUMN stripe_connect_onboarded BOOLEAN NOT NULL DEFAULT false;

-- Update payment_method check to include 'stripe'
ALTER TABLE affiliates DROP CONSTRAINT IF EXISTS affiliates_payment_method_check;
ALTER TABLE affiliates ADD CONSTRAINT affiliates_payment_method_check
    CHECK (payment_method IN ('paypal', 'bank', 'stripe'));
