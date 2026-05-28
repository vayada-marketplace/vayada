ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS show_room_detail_map BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS points_of_interest JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE booking_hotels
    DROP CONSTRAINT IF EXISTS chk_booking_hotels_points_of_interest_is_array,
    ADD CONSTRAINT chk_booking_hotels_points_of_interest_is_array
    CHECK (jsonb_typeof(points_of_interest) = 'array');
