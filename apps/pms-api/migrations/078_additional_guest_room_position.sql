-- Migration 078: per-guest room assignment for multi-room bookings
-- (VAY-495 follow-up).
--
-- room_position links a non-booker guest to one of the booking's rooms by
-- its position in booking_rooms (or position 0 for the primary room on
-- bookings.room_id). Nullable: NULL = not yet assigned to a specific room.
-- The booker (lead guest on bookings.guest_*) is implicitly position 0 — we
-- do not write a row for them.
--
-- No CHECK constraint on the upper bound because we don't know the
-- booking's number_of_rooms at row-insert time without a JOIN; the API
-- validates it on the way in. Cleanups are out of scope: a stale
-- room_position (e.g. after a room is removed) just renders as
-- "Unassigned" client-side.

ALTER TABLE booking_additional_guests
    ADD COLUMN IF NOT EXISTS room_position INTEGER;

CREATE INDEX IF NOT EXISTS idx_booking_additional_guests_room
    ON booking_additional_guests(booking_id, room_position);
