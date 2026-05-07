-- Migration 069: channex_webhook_events delivery log.
--
-- Records every webhook hit from Channex so we can answer "did the
-- `message` event fire for property X today?" without polling Channex's
-- REST API. Replaces the safety-net poll as our way to detect a stuck
-- webhook pipeline.

CREATE TABLE IF NOT EXISTS channex_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    property_id TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_ok BOOLEAN,
    error TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_channex_webhook_events_type_received
    ON channex_webhook_events(event_type, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_channex_webhook_events_property_received
    ON channex_webhook_events(property_id, received_at DESC)
    WHERE property_id IS NOT NULL;
