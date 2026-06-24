-- Migration: 0021_booking_last_minute_settings
-- Owner: domain-booking
-- See: engineering/booking-admin-target-helper-contracts.md
--
-- Adds the target Booking Admin last-minute discount settings surface. Quote
-- calculation rollout is intentionally separate; this stores admin config only.

ALTER TABLE booking.booking_settings
  ADD COLUMN last_minute_discount JSONB NOT NULL
    DEFAULT '{"enabled": false, "stackWithPromo": false, "tiers": []}'::jsonb,
  ADD CONSTRAINT chk_booking_settings_last_minute_discount_object
    CHECK (jsonb_typeof(last_minute_discount) = 'object');
