-- Add guest form field toggles to hotels table
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS special_requests_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS arrival_time_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS guest_count_enabled BOOLEAN NOT NULL DEFAULT false;

-- Add guest form fields to bookings table
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS estimated_arrival_time TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS number_of_guests INTEGER;
