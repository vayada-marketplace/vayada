-- ============================================
-- Make creator profile fields nullable
-- ============================================
-- This allows creating empty creator profiles during registration
-- Users will complete their profile later

ALTER TABLE public.creators
  ALTER COLUMN location DROP NOT NULL,
  ALTER COLUMN short_description DROP NOT NULL;

-- Update the comment to reflect that these are now optional initially
COMMENT ON COLUMN public.creators.location IS 'Creator location. Required for profile completion but can be NULL initially.';
COMMENT ON COLUMN public.creators.short_description IS 'Short description of the creator. Required for profile completion but can be NULL initially.';





