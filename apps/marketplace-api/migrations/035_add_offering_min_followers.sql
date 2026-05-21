-- Migration 035: per-offering min_followers
--
-- VAY-266: properties want to differentiate creator-follower requirements
-- per offering (e.g. Free Stay only for 100k+, Discount for 10k+) and per
-- month (by maintaining multiple offerings of the same type with different
-- availability_months). This adds the per-offering follower threshold; the
-- listing-level value on listing_creator_requirements stays as the
-- fallback baseline.

ALTER TABLE public.listing_collaboration_offerings
    ADD COLUMN IF NOT EXISTS min_followers integer
        CHECK (min_followers IS NULL OR min_followers > 0);

COMMENT ON COLUMN public.listing_collaboration_offerings.min_followers IS
    'Optional per-offering minimum follower threshold. When NULL, the listing-level listing_creator_requirements.min_followers applies.';
