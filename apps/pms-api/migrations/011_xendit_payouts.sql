-- hotel_payment_settings: add provider selection + Xendit bank details
ALTER TABLE hotel_payment_settings
    ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'stripe',
    ADD COLUMN xendit_channel_code TEXT,
    ADD COLUMN xendit_account_number TEXT,
    ADD COLUMN xendit_account_holder_name TEXT;

ALTER TABLE hotel_payment_settings
    ADD CONSTRAINT hps_payment_provider_check
    CHECK (payment_provider IN ('stripe', 'xendit'));

-- affiliates: add Xendit bank details + update payment_method check
ALTER TABLE affiliates
    ADD COLUMN xendit_channel_code TEXT,
    ADD COLUMN xendit_account_number TEXT,
    ADD COLUMN xendit_account_holder_name TEXT;

ALTER TABLE affiliates DROP CONSTRAINT IF EXISTS affiliates_payment_method_check;
ALTER TABLE affiliates ADD CONSTRAINT affiliates_payment_method_check
    CHECK (payment_method IN ('paypal', 'bank', 'stripe', 'xendit'));

-- payouts: add xendit_payout_id alongside stripe_transfer_id
ALTER TABLE payouts ADD COLUMN xendit_payout_id TEXT;
