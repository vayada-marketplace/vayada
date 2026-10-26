-- Migration: 0509_booking_location_map_switch
-- Owner: domain-booking / VAY-2126
--
-- Booking Admin switch "Location map on your booking page". Every existing and new hotel starts off,
-- so guests see no change at release. On shows a map of the rooms' own pins (room_attributes
-- latitude/longitude) below the room list, or the property's pin when no room has one.
-- Guests read it live, outside the booking page publication: switching it leaves updated_at alone.

ALTER TABLE booking.booking_settings
ADD COLUMN location_map_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN booking.booking_settings.location_map_enabled IS
  'Booking Admin "Location map on your booking page" switch (VAY-2126): whether guests see the rooms map.';
