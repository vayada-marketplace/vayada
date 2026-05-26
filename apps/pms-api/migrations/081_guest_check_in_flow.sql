-- VAY-521: Persist PMS guest check-in completion and any non-blocking
-- registration/payment flags carried through the flow.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS check_in_pending_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'checked_in', 'in_house', 'cancelled', 'declined', 'expired'));
