-- Add retry tracking to payouts table
ALTER TABLE payouts ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE payouts ADD COLUMN last_error TEXT;
