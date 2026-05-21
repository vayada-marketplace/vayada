ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS custom_filters JSONB DEFAULT '{}';
