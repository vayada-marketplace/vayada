ALTER TABLE payouts
    ADD COLUMN payment_method TEXT,
    ADD COLUMN external_reference TEXT,
    ADD COLUMN notes TEXT,
    ADD COLUMN paid_by_user_id UUID;
