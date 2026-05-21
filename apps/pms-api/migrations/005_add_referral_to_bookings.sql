ALTER TABLE bookings
    ADD COLUMN affiliate_id UUID REFERENCES affiliates(id) ON DELETE SET NULL,
    ADD COLUMN referral_code TEXT;
CREATE INDEX idx_bookings_affiliate_id ON bookings(affiliate_id);
