-- Migration 015: Beds24 channel manager integration
-- Tables for connections, room mappings, and booking mappings

CREATE TABLE beds24_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    beds24_property_id TEXT,
    api_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    webhook_secret TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_beds24_connections_hotel_id ON beds24_connections(hotel_id);
CREATE INDEX idx_beds24_connections_property_id ON beds24_connections(beds24_property_id);

CREATE TABLE beds24_room_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    beds24_room_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_beds24_room_mappings_room_type ON beds24_room_mappings(room_type_id);
CREATE UNIQUE INDEX idx_beds24_room_mappings_beds24_room ON beds24_room_mappings(beds24_room_id);
CREATE INDEX idx_beds24_room_mappings_hotel ON beds24_room_mappings(hotel_id);

CREATE TABLE beds24_booking_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    beds24_booking_id TEXT NOT NULL,
    channel_source TEXT NOT NULL DEFAULT 'beds24',
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_beds24_booking_mappings_booking ON beds24_booking_mappings(booking_id);
CREATE UNIQUE INDEX idx_beds24_booking_mappings_beds24 ON beds24_booking_mappings(beds24_booking_id);
CREATE INDEX idx_beds24_booking_mappings_hotel ON beds24_booking_mappings(hotel_id);
