-- VAY-398: foundation for Lodgify-backed booking-engine hotels.
-- Adds the pms_type discriminator on booking_hotels and creates the
-- lodgify_connections table that stores the per-hotel API key
-- (encrypted at rest by app.utils.integration_secrets).

ALTER TABLE booking_hotels
    ADD COLUMN IF NOT EXISTS pms_type TEXT NOT NULL DEFAULT 'vayada_native'
        CHECK (pms_type IN ('vayada_native', 'lodgify'));

CREATE TABLE IF NOT EXISTS lodgify_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL UNIQUE REFERENCES booking_hotels(id) ON DELETE CASCADE,
    api_key_encrypted TEXT NOT NULL,
    lodgify_property_id TEXT NOT NULL,
    lodgify_property_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disconnected', 'error')),
    last_validated_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lodgify_connections_hotel_id
    ON lodgify_connections (hotel_id);
