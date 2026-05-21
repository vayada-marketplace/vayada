-- Migration 031: Add restriction fields for Channex ARI sync
-- These fields control min stay, stop sell, CTA/CTD sent to OTAs

ALTER TABLE room_types ADD COLUMN IF NOT EXISTS min_stay INTEGER NOT NULL DEFAULT 1;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_stay INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS closed_to_arrival BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS closed_to_departure BOOLEAN NOT NULL DEFAULT false;
