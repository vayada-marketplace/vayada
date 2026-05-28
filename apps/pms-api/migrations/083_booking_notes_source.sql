-- Migration 083: record where an internal booking note was created.

ALTER TABLE booking_notes
    ADD COLUMN IF NOT EXISTS source TEXT;
