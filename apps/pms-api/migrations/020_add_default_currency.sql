-- Migration 020: Add default currency setting per hotel
ALTER TABLE hotel_payment_settings ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'EUR';
