-- Add addon tracking fields to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS addon_total NUMERIC(10,2) NOT NULL DEFAULT 0;
