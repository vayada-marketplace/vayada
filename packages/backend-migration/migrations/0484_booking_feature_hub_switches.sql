-- Migration: 0484_booking_feature_hub_switches
-- Owner: domain-booking / VAY-2200
--
-- Feature Hub "Add-ons" and "Promos" switches. Every existing and new hotel starts on, so guests see
-- no change at release. Off hides the module's Booking Engine page and its guest step or field;
-- stored add-ons, codes, their usage and existing bookings stay as they are.
-- - addons_enabled is the module itself. show_addons_step stays the separate display choice on the
--   Add-ons page, so a hotel that hid the step keeps its Add-ons page.
-- - Discounts without a code (last-minute) keep their own switch.

ALTER TABLE booking.booking_settings
ADD COLUMN addons_enabled BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN promo_codes_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN booking.booking_settings.addons_enabled IS
  'Feature Hub Add-ons switch (VAY-2200): whether guests are offered add-ons at all.';
COMMENT ON COLUMN booking.booking_settings.promo_codes_enabled IS
  'Feature Hub Promos switch (VAY-2200): whether guests can enter promo codes.';
