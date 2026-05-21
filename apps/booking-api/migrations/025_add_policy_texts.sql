ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS terms_text TEXT NOT NULL DEFAULT '';
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS cancellation_policy_text TEXT NOT NULL DEFAULT '';
