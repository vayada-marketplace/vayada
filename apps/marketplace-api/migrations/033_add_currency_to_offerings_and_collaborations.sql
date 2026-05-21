-- ============================================
-- Add currency field to paid collaboration offerings and collaborations
-- ============================================
-- Hotels can specify the currency of their Paid offerings (e.g. USD, IDR, EUR).
-- Collaboration records store their own currency because the negotiated
-- paid_amount can differ from the offering.
-- Existing rows default to 'USD'.

ALTER TABLE public.listing_collaboration_offerings
ADD COLUMN currency text NOT NULL DEFAULT 'USD'
CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN public.listing_collaboration_offerings.currency IS 'ISO 4217 three-letter currency code (e.g. USD, IDR, EUR). Only meaningful when collaboration_type = "Paid".';

ALTER TABLE public.collaborations
ADD COLUMN currency text NOT NULL DEFAULT 'USD'
CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN public.collaborations.currency IS 'ISO 4217 three-letter currency code for paid_amount (e.g. USD, IDR, EUR). Only meaningful when collaboration_type = "Paid".';
