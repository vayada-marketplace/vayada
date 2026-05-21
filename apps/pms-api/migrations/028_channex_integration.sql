-- Migration 028: Channex channel manager integration
-- Tables for connections, property/room/rate provisioning, and booking mappings

-- Connection: one per hotel, stores API key and active state
CREATE TABLE channex_connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    channex_property_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_booking_sync_at TIMESTAMPTZ,
    last_ari_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_channex_connections_hotel_id ON channex_connections(hotel_id);
CREATE INDEX idx_channex_connections_property_id ON channex_connections(channex_property_id);

-- Room type mapping: links vayada room_type to Channex room_type + tracks provisioning
CREATE TABLE channex_room_type_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    channex_room_type_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_channex_room_mappings_room_type ON channex_room_type_mappings(room_type_id);
CREATE UNIQUE INDEX idx_channex_room_mappings_channex ON channex_room_type_mappings(channex_room_type_id);
CREATE INDEX idx_channex_room_mappings_hotel ON channex_room_type_mappings(hotel_id);

-- Rate plan mapping: links vayada room_type to Channex rate_plan
CREATE TABLE channex_rate_plan_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
    channex_rate_plan_id UUID NOT NULL,
    channex_room_type_id UUID NOT NULL,
    sell_mode TEXT NOT NULL DEFAULT 'per_room',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_channex_rate_plan_mappings_room_type ON channex_rate_plan_mappings(room_type_id);
CREATE UNIQUE INDEX idx_channex_rate_plan_mappings_channex ON channex_rate_plan_mappings(channex_rate_plan_id);
CREATE INDEX idx_channex_rate_plan_mappings_hotel ON channex_rate_plan_mappings(hotel_id);

-- Booking mapping: links vayada booking to Channex booking revision
CREATE TABLE channex_booking_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    channex_booking_id UUID NOT NULL,
    channex_revision_id UUID,
    channel_source TEXT NOT NULL DEFAULT 'channex',
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_channex_booking_mappings_booking ON channex_booking_mappings(booking_id);
CREATE UNIQUE INDEX idx_channex_booking_mappings_channex ON channex_booking_mappings(channex_booking_id);
CREATE INDEX idx_channex_booking_mappings_hotel ON channex_booking_mappings(hotel_id);
