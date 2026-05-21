-- Store promo discount info on bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
