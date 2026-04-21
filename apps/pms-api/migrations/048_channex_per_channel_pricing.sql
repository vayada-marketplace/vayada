-- Migration 048: Per-channel pricing via Channex
-- Adds a channel dimension to rate plan mappings and a new table for
-- per-hotel markup percentages on Booking.com and Airbnb.

-- 1. Per-hotel markup table.
--    Direct channel is implicit (0% markup), so it has no row here.
CREATE TABLE channex_channel_markups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    markup_pct NUMERIC(6,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_channex_channel_markups_hotel_channel
    ON channex_channel_markups(hotel_id, channel);

-- 2. Add channel to rate plan mappings. Existing rows default to 'direct'
--    so they keep serving as the fallback plan (the pre-feature behavior).
ALTER TABLE channex_rate_plan_mappings
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'direct';

-- 3. Replace the room_type index with a composite unique constraint on
--    (room_type_id, channel, plan_name) so provisioning is idempotent per
--    channel/plan combination and we don't double-create rate plans.
DROP INDEX IF EXISTS idx_channex_rate_plan_mappings_room_type;
CREATE UNIQUE INDEX idx_channex_rate_plan_mappings_room_channel_plan
    ON channex_rate_plan_mappings(room_type_id, channel, plan_name);
