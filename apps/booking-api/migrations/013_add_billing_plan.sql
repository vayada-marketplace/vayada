ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS billing_active_plan TEXT NOT NULL DEFAULT 'commission';
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS billing_commission_rate NUMERIC NOT NULL DEFAULT 5;
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS billing_fixed_fee NUMERIC NOT NULL DEFAULT 49;
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS billing_pending_switch TEXT;
