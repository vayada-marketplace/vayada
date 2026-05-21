-- Unified messaging: conversations, messages, and sync state

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    channel TEXT NOT NULL DEFAULT 'direct'
        CHECK (channel IN ('direct', 'beds24', 'airbnb', 'booking.com', 'email')),
    guest_name TEXT NOT NULL DEFAULT '',
    guest_email TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'closed', 'archived')),
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    beds24_booking_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_hotel ON conversations(hotel_id);
CREATE INDEX idx_conversations_booking ON conversations(booking_id);
CREATE INDEX idx_conversations_beds24 ON conversations(beds24_booking_id);
CREATE INDEX idx_conversations_hotel_last_msg ON conversations(hotel_id, last_message_at DESC);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL
        CHECK (sender_type IN ('guest', 'host', 'system')),
    sender_name TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'direct'
        CHECK (channel IN ('direct', 'beds24', 'airbnb', 'booking.com', 'email')),
    beds24_message_id TEXT,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX idx_messages_beds24_dedup ON messages(beds24_message_id) WHERE beds24_message_id IS NOT NULL;

CREATE TABLE message_sync_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    last_polled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_message_sync_state_hotel ON message_sync_state(hotel_id);
