ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS non_refundable_cancellation_policy TEXT DEFAULT 'Non-refundable from booking';
