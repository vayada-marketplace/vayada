ALTER TABLE booking_hotels
ADD COLUMN IF NOT EXISTS booking_filters JSONB DEFAULT '["includeBreakfast","freeCancellation","payAtHotel","bestRated","mountainView"]'::jsonb;
