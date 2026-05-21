-- ============================================
-- Add target_age_groups to listing_creator_requirements
-- ============================================
-- This allows storing specific age group buckets (e.g., '18-24', '25-34')
-- to avoid incorrectly filling in middle groups when reconstructing from min/max range.

ALTER TABLE public.listing_creator_requirements
ADD COLUMN target_age_groups text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.listing_creator_requirements.target_age_groups IS 'Array of specific target age group buckets: e.g., ["18-24", "25-34", "35-44", "45-54", "55+"].';
