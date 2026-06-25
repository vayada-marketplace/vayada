-- Migration: 0023_booking_guest_type_settings
-- Owner: domain-booking
-- See: engineering/booking-guest-form-settings-contract.md, engineering/booking-settings-write-contracts.md
--
-- Adds the target guest-type settings needed for Booking Admin and Booking Web
-- parity with the old stack VAY-891 behavior.

ALTER TABLE booking.booking_settings
  ADD COLUMN adult_age_threshold INTEGER NOT NULL DEFAULT 18,
  ADD COLUMN children_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD CONSTRAINT chk_booking_settings_adult_age_threshold
    CHECK (adult_age_threshold BETWEEN 1 AND 120);
