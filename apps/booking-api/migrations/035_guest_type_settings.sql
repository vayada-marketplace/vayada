ALTER TABLE booking_hotels
  ADD COLUMN IF NOT EXISTS guest_adult_age_threshold INTEGER NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS guest_children_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE booking_hotels
  DROP CONSTRAINT IF EXISTS booking_hotels_guest_adult_age_threshold_chk;

ALTER TABLE booking_hotels
  ADD CONSTRAINT booking_hotels_guest_adult_age_threshold_chk
  CHECK (guest_adult_age_threshold >= 1 AND guest_adult_age_threshold <= 99);
