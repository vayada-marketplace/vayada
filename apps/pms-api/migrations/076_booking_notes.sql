-- Migration 076: booking_notes — internal staff notes attached to a booking
-- (VAY-495 booking-detail card #5).
--
-- These are PMS-internal only: never shown to the guest, never sent over
-- channel manager. Each note records its author so the detail page can show
-- "Maria · 23 May 2026 14:32".

CREATE TABLE IF NOT EXISTS booking_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    -- Denormalised to keep the per-hotel access filter on a single column;
    -- bookings.hotel_id is the source of truth and never changes after insert.
    hotel_id UUID NOT NULL,
    -- The auth-db user that wrote the note. Stored as plain UUID (no FK)
    -- because the auth DB lives in a separate database.
    author_user_id UUID NOT NULL,
    -- Author display name captured at write time so deleted/renamed users
    -- still render correctly on old notes.
    author_name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_notes_booking_id
    ON booking_notes(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_notes_hotel_id
    ON booking_notes(hotel_id);
