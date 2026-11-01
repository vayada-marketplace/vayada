-- Migration: 0534_booking_room_sorting
-- Owner: domain-booking / VAY-2449
--
-- Booking Admin › Settings › Room Sorting: whether guests can sort the rooms, whether the menu hides
-- for a single room, which sort options the menu shows in which order, and the default one. One JSON
-- object per hotel, validated by next-api. NULL (every existing and new hotel) means the defaults:
-- sorting on, hidden for one room, Recommended / Price low–high / Price high–low / Room size, with
-- Recommended first and default.
-- Guests read it live with the room catalogue, outside the booking page publication: the
-- publication's settings hash does not include this column, and saving it leaves updated_at alone.

SET LOCAL lock_timeout = '5s';

ALTER TABLE booking.booking_settings
ADD COLUMN room_sorting JSONB CHECK (room_sorting IS NULL OR jsonb_typeof(room_sorting) = 'object');

COMMENT ON COLUMN booking.booking_settings.room_sorting IS
  'Booking Admin Room Sorting (VAY-2449): the guest sort menu''s switch, one-room auto-hide, options in order and default. NULL: the defaults.';
