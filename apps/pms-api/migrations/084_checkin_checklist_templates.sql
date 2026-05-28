-- VAY-539: Per-property custom check-in checklist templates and immutable
-- check-in snapshots.

CREATE TABLE IF NOT EXISTS checkin_checklist_templates (
    hotel_id UUID PRIMARY KEY REFERENCES hotels(id) ON DELETE CASCADE,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID
);

CREATE TABLE IF NOT EXISTS booking_checkin_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_by UUID,
    step_results JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_flags JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_booking_checkin_records_booking_id
    ON booking_checkin_records (booking_id, completed_at DESC);
