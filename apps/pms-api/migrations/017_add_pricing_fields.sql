ALTER TABLE room_types ADD COLUMN IF NOT EXISTS operating_periods JSONB DEFAULT '[]'::jsonb;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS seasons JSONB DEFAULT '[]'::jsonb;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS weekend_surcharge TEXT DEFAULT '+0%';
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS cancellation_policy TEXT DEFAULT 'Free until 7 days before';
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS flexible_rate_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS non_refundable_discount INTEGER DEFAULT 10;
