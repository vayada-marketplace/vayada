ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS pay_at_hotel_methods JSONB NOT NULL DEFAULT '["cash", "card"]';
