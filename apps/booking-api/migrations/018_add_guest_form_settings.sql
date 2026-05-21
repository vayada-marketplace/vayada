-- Add guest form field toggles to booking_hotels
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS special_requests_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS arrival_time_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS guest_count_enabled BOOLEAN NOT NULL DEFAULT false;
