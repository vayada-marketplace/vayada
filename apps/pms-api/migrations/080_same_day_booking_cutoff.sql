ALTER TABLE hotels
    ADD COLUMN IF NOT EXISTS same_day_bookings_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS same_day_booking_cutoff_time TEXT DEFAULT '18:00';
