-- Migration 036: drop listing-level min_followers
--
-- VAY-327: the hotel listing form had two "minimum followers" inputs — one
-- per offering (intended) and a duplicate listing-level fallback in the
-- "Looking For" section. The product no longer wants the duplicate; the
-- per-offering threshold (migrations/035) becomes the single source of
-- truth. Drop the column from listing_creator_requirements.

ALTER TABLE public.listing_creator_requirements
    DROP COLUMN IF EXISTS min_followers;
