ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS is_test_booking BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_bookings_hotel_created_test
  ON bookings (hotel_id, created_at, is_test_booking);
