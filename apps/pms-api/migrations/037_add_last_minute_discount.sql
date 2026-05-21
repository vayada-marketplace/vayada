-- Last-minute automatic discount: hotel-wide config, per-room override, booking tracking

-- Hotel-wide default discount tiers
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS last_minute_discount JSONB;

-- Per-room-type override (when set, overrides hotel-wide for that room)
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS last_minute_discount JSONB;

-- Track applied discount on each booking for auditing
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_minute_discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_minute_discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0;
