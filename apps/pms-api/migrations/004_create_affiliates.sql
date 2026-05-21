CREATE TABLE affiliates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    referral_code TEXT NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    social_media TEXT NOT NULL DEFAULT '',
    user_type TEXT NOT NULL DEFAULT 'guest'
        CHECK (user_type IN ('guest', 'creator')),
    payment_method TEXT NOT NULL DEFAULT 'paypal'
        CHECK (payment_method IN ('paypal', 'bank')),
    paypal_email TEXT NOT NULL DEFAULT '',
    bank_iban TEXT NOT NULL DEFAULT '',
    commission_pct NUMERIC(5,2) NOT NULL DEFAULT 5.00,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, referral_code),
    UNIQUE (hotel_id, email)
);
CREATE INDEX idx_affiliates_hotel_id ON affiliates(hotel_id);
CREATE INDEX idx_affiliates_referral_code ON affiliates(referral_code);
