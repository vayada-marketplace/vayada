ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS location_address TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,7),
    ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

ALTER TABLE room_types
    DROP CONSTRAINT IF EXISTS chk_room_types_latitude_range,
    ADD CONSTRAINT chk_room_types_latitude_range
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);

ALTER TABLE room_types
    DROP CONSTRAINT IF EXISTS chk_room_types_longitude_range,
    ADD CONSTRAINT chk_room_types_longitude_range
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
