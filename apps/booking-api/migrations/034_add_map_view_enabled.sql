ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS map_view_enabled BOOLEAN NOT NULL DEFAULT false;
