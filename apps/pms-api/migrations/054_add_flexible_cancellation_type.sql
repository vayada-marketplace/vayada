ALTER TABLE room_types
    ADD COLUMN IF NOT EXISTS flexible_cancellation_type TEXT NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS partial_refund_cancel_window_days INT NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS partial_refund_amount_percent INT NOT NULL DEFAULT 50;
