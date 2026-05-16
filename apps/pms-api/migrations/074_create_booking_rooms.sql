-- Migration 074: booking_rooms — the extra physical rooms a multi-room
-- booking occupies beyond its primary room (VAY-403).
--
-- Before this, a multi-room booking (e.g. "2x Two-Bedroom Pool Villa") was a
-- single bookings row with number_of_rooms = 2 but only one room_id. Only one
-- physical room was ever blocked on the calendar; the second stayed open for
-- sale -> silent double-booking + payment shown for one room.
--
-- Model: the FIRST assigned room stays in bookings.room_id exactly as today
-- (position 0, implicit) so every existing single-room read/move/cancel path
-- is byte-for-byte unchanged and single-room bookings get ZERO rows here.
-- This table holds only the ADDITIONAL rooms (positions 1..N-1). The full
-- ordered room list a surface shows is [bookings.room_id] + booking_rooms
-- ordered by position.
--
-- ON DELETE CASCADE on booking_id releases every extra room if the booking
-- row is ever deleted; status-based cancellation needs no cleanup here since
-- all calendar/availability reads already filter by bookings.status.
-- ON DELETE CASCADE on room_id mirrors room_blocks (migration 050).
--
-- No backfill: pre-fix multi-room bookings only ever stored one room, so
-- there are no historical extras to record. Reconciling those under-assigned
-- bookings is the out-of-scope one-time ops audit noted on VAY-403.

CREATE TABLE booking_rooms (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- One slot index per booking; one physical room used at most once per booking.
CREATE UNIQUE INDEX idx_booking_rooms_booking_position
    ON booking_rooms(booking_id, position);
CREATE UNIQUE INDEX idx_booking_rooms_booking_room
    ON booking_rooms(booking_id, room_id);
CREATE INDEX idx_booking_rooms_booking_id ON booking_rooms(booking_id);
CREATE INDEX idx_booking_rooms_room_id ON booking_rooms(room_id);
