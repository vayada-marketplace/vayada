-- Migration 063: Multichannel inbox tables (Channex messaging, extensible to other sources)
-- Replaces the schema dropped in migration 030 ("Channex does not support OTA messaging" — that was wrong;
-- Channex's Messaging & Reviews App covers BDC, Airbnb, Expedia).

CREATE TYPE message_source AS ENUM ('channex');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE thread_status AS ENUM ('open', 'closed', 'no_reply_needed');

CREATE TABLE message_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    source message_source NOT NULL,
    source_thread_id TEXT NOT NULL,
    booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    source_booking_id TEXT,
    channel TEXT,
    guest_name TEXT,
    guest_email TEXT,
    status thread_status NOT NULL DEFAULT 'open',
    last_message_at TIMESTAMPTZ,
    last_message_preview TEXT,
    last_message_direction message_direction,
    unread_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_thread_id)
);
CREATE INDEX idx_message_threads_hotel_recent
    ON message_threads (hotel_id, last_message_at DESC NULLS LAST);
CREATE INDEX idx_message_threads_booking ON message_threads (booking_id);
CREATE INDEX idx_message_threads_unread
    ON message_threads (hotel_id) WHERE unread_count > 0;

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
    source_message_id TEXT NOT NULL,
    direction message_direction NOT NULL,
    sender_name TEXT,
    body TEXT NOT NULL DEFAULT '',
    sent_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    raw_payload JSONB,
    UNIQUE (thread_id, source_message_id)
);
CREATE INDEX idx_messages_thread_sent ON messages (thread_id, sent_at);

CREATE TABLE message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    s3_key TEXT,
    source_url TEXT,
    filename TEXT,
    content_type TEXT,
    size_bytes INT,
    source_attachment_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_attachments_message ON message_attachments (message_id);

ALTER TABLE channex_connections
    ADD COLUMN messaging_app_installed BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN last_message_sync_at TIMESTAMPTZ;
