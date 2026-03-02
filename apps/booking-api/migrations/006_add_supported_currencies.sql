-- Add supported_currencies column to booking_hotels
ALTER TABLE booking_hotels
ADD COLUMN IF NOT EXISTS supported_currencies JSONB NOT NULL DEFAULT '[]'::jsonb;
