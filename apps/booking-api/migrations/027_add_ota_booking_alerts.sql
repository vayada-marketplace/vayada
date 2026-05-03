ALTER TABLE booking_hotels
  ADD COLUMN IF NOT EXISTS ota_booking_alerts BOOLEAN NOT NULL DEFAULT false;
