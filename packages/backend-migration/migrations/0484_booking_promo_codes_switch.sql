-- Migration: 0484_booking_promo_codes_switch
-- Owner: domain-booking / VAY-2200
--
-- Feature Hub "Promos" switch. Every existing and new hotel starts on, so guests see no change at
-- release. Off hides the promo code field and new quotes ignore codes; stored codes, their usage
-- and existing bookings stay as they are. Discounts without a code (last-minute) keep their own
-- switch. The Feature Hub "Add-ons" switch is the existing show_addons_step column.

ALTER TABLE booking.booking_settings
ADD COLUMN promo_codes_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN booking.booking_settings.promo_codes_enabled IS
  'Feature Hub Promos switch (VAY-2200): whether guests can enter promo codes.';
