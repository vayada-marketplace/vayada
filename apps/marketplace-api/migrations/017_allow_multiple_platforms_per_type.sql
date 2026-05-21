-- ============================================
-- Allow creators to have multiple accounts of the same platform
-- ============================================
-- This migration removes the unique constraint that prevents a creator
-- from having multiple Instagram, TikTok, YouTube, or Facebook accounts

-- Remove the unique constraint
ALTER TABLE public.creator_platforms
DROP CONSTRAINT IF EXISTS creator_platforms_creator_platform_unique;

-- Add a comment explaining the change
COMMENT ON TABLE public.creator_platforms IS 'Social media platforms for creators. One creator can have multiple platforms, including multiple accounts of the same platform type (e.g., 2 Instagram accounts).';

