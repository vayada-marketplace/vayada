-- Add filter_rooms column to store which rooms each filter applies to.
-- Structure: {"filterKey": ["roomId1", "roomId2"], ...}
ALTER TABLE booking_hotels
ADD COLUMN IF NOT EXISTS filter_rooms JSONB DEFAULT '{}'::jsonb;
