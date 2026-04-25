-- Migration 034: Add 'Affiliate' as a fourth collaboration type with commission_percentage
-- Date: 2026-04-22
--
-- Adds 'Affiliate' to the allowed values on both listing_collaboration_offerings and
-- collaborations. Introduces listing_collaboration_offerings.commission_percentage
-- (required when collaboration_type = 'Affiliate', forbidden otherwise).
-- Reuses the existing collaborations.creator_fee column (added in migration 030) as
-- the per-collaboration commission value, and enforces it is set for Affiliate.

-- ─────────────────────────────────────────────
-- listing_collaboration_offerings
-- ─────────────────────────────────────────────

-- Widen the collaboration_type CHECK to include 'Affiliate'
ALTER TABLE public.listing_collaboration_offerings
  DROP CONSTRAINT listing_collaboration_offerings_collaboration_type_check;

ALTER TABLE public.listing_collaboration_offerings
  ADD CONSTRAINT listing_collaboration_offerings_collaboration_type_check
  CHECK (collaboration_type IN ('Free Stay', 'Paid', 'Discount', 'Affiliate'));

-- Add commission_percentage column with same conditional pattern as discount_percentage
ALTER TABLE public.listing_collaboration_offerings
  ADD COLUMN commission_percentage integer
  CHECK (
    (collaboration_type = 'Affiliate' AND commission_percentage IS NOT NULL
      AND commission_percentage >= 1 AND commission_percentage <= 100) OR
    (collaboration_type != 'Affiliate' AND commission_percentage IS NULL)
  );

COMMENT ON COLUMN public.listing_collaboration_offerings.commission_percentage IS 'Commission percentage (1-100) paid to creators on bookings driven by their affiliate link. Required only if collaboration_type = "Affiliate".';

-- ─────────────────────────────────────────────
-- collaborations
-- ─────────────────────────────────────────────

-- Widen the collaboration_type CHECK to include 'Affiliate'
ALTER TABLE public.collaborations
  DROP CONSTRAINT collaborations_collaboration_type_check;

ALTER TABLE public.collaborations
  ADD CONSTRAINT collaborations_collaboration_type_check
  CHECK (collaboration_type IN ('Free Stay', 'Paid', 'Discount', 'Affiliate'));

-- Require creator_fee when collaboration_type = 'Affiliate' (NUMERIC(5,2) already added in migration 030)
ALTER TABLE public.collaborations
  ADD CONSTRAINT check_affiliate_fields
  CHECK (
    (collaboration_type != 'Affiliate') OR
    (collaboration_type = 'Affiliate' AND creator_fee IS NOT NULL
      AND creator_fee >= 1 AND creator_fee <= 100)
  );

COMMENT ON COLUMN public.collaborations.creator_fee IS 'Commission percentage (1-100) paid to the creator for Affiliate collaborations. Required when collaboration_type = "Affiliate".';
COMMENT ON COLUMN public.collaborations.collaboration_type IS 'Type of collaboration: "Free Stay", "Paid", "Discount", or "Affiliate". Required for hotel invitations, optional for creator applications (creators can propose custom terms)';
