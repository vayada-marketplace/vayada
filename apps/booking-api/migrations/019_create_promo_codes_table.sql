CREATE TABLE booking_promo_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES booking_hotels(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    discount_type VARCHAR(20) NOT NULL DEFAULT 'percentage',
    discount_value NUMERIC(10,2) NOT NULL,
    valid_from DATE,
    valid_until DATE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, code)
);

CREATE INDEX idx_promo_codes_hotel ON booking_promo_codes(hotel_id);
