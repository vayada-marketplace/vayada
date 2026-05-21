-- Migration 060: booking_events audit log.
--
-- Generic per-booking event log so admin actions (room moves, future
-- audit needs) are recorded with timestamp + actor. Kept intentionally
-- simple: one row per event, payload as JSONB so each event_type
-- defines its own shape without further schema churn.

CREATE TABLE IF NOT EXISTS booking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking_id
    ON booking_events(booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_booking_events_hotel_id
    ON booking_events(hotel_id, created_at DESC);
