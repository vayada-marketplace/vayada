-- Add default_language column to booking_hotels
ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS default_language TEXT NOT NULL DEFAULT 'en';
