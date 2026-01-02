-- Migration 020: Make target_countries optional in listing_creator_requirements
-- term: Top Countries to match UI terminology

ALTER TABLE public.listing_creator_requirements 
ALTER COLUMN target_countries DROP NOT NULL,
ALTER COLUMN target_countries SET DEFAULT NULL;

-- Update comment to reflect new terminology and optionality
COMMENT ON COLUMN public.listing_creator_requirements.target_countries IS 'Array of top audience countries (Top Countries). Optional field.';
