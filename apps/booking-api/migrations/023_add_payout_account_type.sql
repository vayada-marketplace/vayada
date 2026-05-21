ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS payout_account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE booking_hotels ADD COLUMN IF NOT EXISTS payout_account_type TEXT NOT NULL DEFAULT 'iban';
