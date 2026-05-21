-- Add online_card_payment and bank_transfer columns to hotel_payment_settings
ALTER TABLE hotel_payment_settings
  ADD COLUMN IF NOT EXISTS online_card_payment BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_transfer BOOLEAN NOT NULL DEFAULT false;
