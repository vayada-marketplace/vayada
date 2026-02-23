-- Add supported_currencies column to booking_hotels
ALTER TABLE booking_hotels
ADD COLUMN supported_currencies JSONB NOT NULL DEFAULT '[]'::jsonb;
