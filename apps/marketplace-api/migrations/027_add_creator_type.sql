-- ============================================
-- Add creator_type to creators table
-- ============================================
-- This differentiates between Lifestyle and Travel creators
-- Lifestyle: Lifestyle content creators
-- Travel: Travel-focused content creators

ALTER TABLE public.creators
ADD COLUMN creator_type text NOT NULL DEFAULT 'Lifestyle'
CHECK (creator_type IN ('Lifestyle', 'Travel'));

CREATE INDEX idx_creators_type ON public.creators(creator_type);

COMMENT ON COLUMN public.creators.creator_type IS 'Type of creator: Lifestyle (lifestyle content) or Travel (travel-focused content). Required field.';

-- ============================================
-- Add creator_types to listing_creator_requirements
-- ============================================
-- This allows hotels to specify which types of creators they want

ALTER TABLE public.listing_creator_requirements
ADD COLUMN creator_types text[] DEFAULT '{}';

COMMENT ON COLUMN public.listing_creator_requirements.creator_types IS 'Array of preferred creator types: e.g., ["Lifestyle", "Travel"]. Empty array means no preference.';
