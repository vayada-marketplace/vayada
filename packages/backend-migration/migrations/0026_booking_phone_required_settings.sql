-- Migration: 0026_booking_phone_required_settings
-- Owner: domain-booking
-- See: engineering/booking-guest-form-settings-contract.md, VAY-646/VAY-977
--
-- Adds target guest phone required/optional parity for Booking Admin and
-- public checkout. Default TRUE preserves existing required-phone behavior.

ALTER TABLE booking.booking_settings
  ADD COLUMN phone_required BOOLEAN NOT NULL DEFAULT TRUE;
