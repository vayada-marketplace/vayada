-- Migration: 0532_booking_gallery_button_switch
-- Owner: domain-booking / VAY-2447
--
-- Design Studio "Gallery button" switch in the booking page header, next to Contact. Every existing
-- and new hotel starts on, so guests see no change at release. The page hides the button anyway when
-- the hotel has fewer than two photos.
-- Guests read it live, outside the booking page publication: the publication's settings hash does
-- not include this column, so adding it marks no page as changed.

ALTER TABLE booking.booking_settings
ADD COLUMN show_gallery_button BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN booking.booking_settings.show_gallery_button IS
  'Design Studio "Gallery button" switch (VAY-2447): whether the booking page header offers the photo gallery.';
