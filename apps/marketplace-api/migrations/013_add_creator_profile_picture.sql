-- ============================================
-- Add profile_picture column to creators table
-- ============================================
-- Adds support for storing creator profile picture URLs (S3 URLs)
-- Similar to hotel_profiles.picture column

ALTER TABLE public.creators
ADD COLUMN IF NOT EXISTS profile_picture text;

-- Index for faster lookups (optional, but useful if querying by picture)
CREATE INDEX IF NOT EXISTS idx_creators_profile_picture ON public.creators(profile_picture) WHERE profile_picture IS NOT NULL;

-- Comments
COMMENT ON COLUMN public.creators.profile_picture IS 'URL to the creator profile picture stored in S3. Format: https://bucket.s3.region.amazonaws.com/creators/user-id/image.jpg';

