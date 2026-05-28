ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS show_room_detail_map BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS points_of_interest JSONB NOT NULL DEFAULT '[]'::jsonb;
