-- Link affiliates to auth user accounts
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS user_id UUID;
CREATE INDEX IF NOT EXISTS idx_affiliates_user_id ON affiliates(user_id);
