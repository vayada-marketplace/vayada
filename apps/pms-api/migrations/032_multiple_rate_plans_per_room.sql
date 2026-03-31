-- Migration 032: Allow multiple rate plans per room type in Channex
-- Drop the unique-on-room_type constraint, add plan_name to distinguish them

DROP INDEX IF EXISTS idx_channex_rate_plan_mappings_room_type;
CREATE INDEX idx_channex_rate_plan_mappings_room_type ON channex_rate_plan_mappings(room_type_id);

ALTER TABLE channex_rate_plan_mappings
    ADD COLUMN IF NOT EXISTS plan_name TEXT NOT NULL DEFAULT 'standard';
