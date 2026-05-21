-- Allow multiple hotels per admin (was UNIQUE, now regular index)
DROP INDEX IF EXISTS idx_booking_hotels_user_id;
CREATE INDEX IF NOT EXISTS idx_booking_hotels_user_id ON booking_hotels (user_id);
