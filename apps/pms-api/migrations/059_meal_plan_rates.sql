-- Migration 059: Meal-plan rate variants pushed via Channex.
--
-- Hosts can offer additional rate plans alongside the base room-only rate
-- (e.g. "Flexible (with breakfast)"). Each enabled meal plan creates an
-- extra Channex rate plan tagged with Booking.com's meal_plan_code so the
-- OTA displays it as a separate bookable row.
--
-- meal_plan codes follow the BDC standard:
--   0 = Room only (the default; never persisted in room_types.meal_plans)
--   1 = Breakfast included
--   3 = Half board
--   4 = Full board
--   9 = All inclusive

-- 1. Per-room enabled meal plans + surcharges.
--    Shape: [{"code": 1, "surcharge": 300000}, ...]
--    Surcharge is per-night, per-room, in the room's currency.
ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS meal_plans JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 2. Tag each Channex rate plan mapping with the meal_plan_code it represents.
--    Existing rows are room-only (0), so the default keeps current mappings
--    behaving exactly as before.
ALTER TABLE channex_rate_plan_mappings
    ADD COLUMN IF NOT EXISTS meal_plan_code INTEGER NOT NULL DEFAULT 0;

-- 3. Replace the (room_type_id, channel, plan_name) unique constraint with
--    one that includes meal_plan_code so provisioning stays idempotent when
--    we create multiple meal-plan variants per (channel, plan_name) combo.
DROP INDEX IF EXISTS idx_channex_rate_plan_mappings_room_channel_plan;
CREATE UNIQUE INDEX idx_channex_rate_plan_mappings_room_channel_plan_meal
    ON channex_rate_plan_mappings(room_type_id, channel, plan_name, meal_plan_code);
