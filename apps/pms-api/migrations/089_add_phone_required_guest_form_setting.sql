-- Allow hotels to make the guest phone field optional in checkout.
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS phone_required BOOLEAN NOT NULL DEFAULT true;
