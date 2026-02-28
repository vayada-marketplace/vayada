ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS pay_at_property_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS free_cancellation_days INTEGER NOT NULL DEFAULT 7;
