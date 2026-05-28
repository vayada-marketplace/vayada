-- VAY-541: Persist PMS guest check-out inspection templates, charges,
-- completion records, and checked-out booking state.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;

UPDATE bookings
SET status = 'cancelled'
WHERE status NOT IN (
    'pending',
    'confirmed',
    'checked_in',
    'in_house',
    'checked_out',
    'cancelled',
    'declined',
    'expired'
);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('pending', 'confirmed', 'checked_in', 'in_house', 'checked_out', 'cancelled', 'declined', 'expired'));

CREATE TABLE IF NOT EXISTS checkout_inspection_templates (
    hotel_id UUID PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID
);

CREATE TABLE IF NOT EXISTS booking_checkout_charges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    original_amount NUMERIC(10,2) NOT NULL CHECK (original_amount >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'waived')),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    waived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_booking_checkout_charges_booking_id
    ON booking_checkout_charges (booking_id, created_at);

CREATE TABLE IF NOT EXISTS booking_checkout_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by UUID,
    inspection_results JSONB NOT NULL DEFAULT '[]'::jsonb,
    charges_settled JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    checkout_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_booking_checkout_records_booking_id
    ON booking_checkout_records (booking_id, completed_at DESC);
