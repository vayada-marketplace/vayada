-- Add settings-related columns to booking_hotels
-- Links each hotel to its owner and adds timezone/language preferences

ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS user_id UUID,
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
    ADD COLUMN IF NOT EXISTS supported_languages JSONB NOT NULL DEFAULT '["en"]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_hotels_user_id ON booking_hotels (user_id);
