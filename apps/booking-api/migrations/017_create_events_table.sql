CREATE TABLE IF NOT EXISTS booking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_slug TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_events_hotel_type_date
    ON booking_events (hotel_slug, event_type, created_at);
