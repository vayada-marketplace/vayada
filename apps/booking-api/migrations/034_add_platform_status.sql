ALTER TABLE booking_hotels
  ADD COLUMN IF NOT EXISTS platform_status TEXT NOT NULL DEFAULT 'live';

ALTER TABLE booking_hotels
  DROP CONSTRAINT IF EXISTS booking_hotels_platform_status_check;

ALTER TABLE booking_hotels
  ADD CONSTRAINT booking_hotels_platform_status_check
  CHECK (platform_status IN ('live', 'demo', 'test'));

CREATE INDEX IF NOT EXISTS idx_booking_hotels_platform_status
  ON booking_hotels (platform_status);
