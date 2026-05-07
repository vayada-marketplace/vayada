-- Migration 037: in-platform notifications
--
-- VAY-385: creators (and other users) need an in-platform notification
-- inbox. The first notification type is "creator_approved", emitted when
-- an admin moves a creator's user.status from non-verified to verified.
-- The notification is created synchronously so it always lands even if
-- the accompanying email fails (per ticket edge case).

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link_url TEXT,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id) WHERE read_at IS NULL;
