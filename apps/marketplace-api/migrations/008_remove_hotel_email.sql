-- ============================================
-- Remove email field from hotel_profiles
-- ============================================
-- Email should only exist in users table (like creators)
-- This ensures single source of truth for email addresses

-- Remove email column from hotel_profiles
ALTER TABLE public.hotel_profiles
DROP COLUMN IF EXISTS email;

-- Update the comment to reflect removal of email
COMMENT ON TABLE public.hotel_profiles IS 'Main hotel account/profile. One user with type=hotel has one hotel profile. A hotel profile can own multiple property listings. Email is stored in users table only.';
