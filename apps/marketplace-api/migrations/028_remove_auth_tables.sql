-- ============================================
-- Remove auth tables from business database
-- ============================================
-- Auth data (users, tokens, consent) is now in the shared auth database.
-- This migration drops FK constraints to users and removes auth tables
-- that are no longer needed in the business database.

-- Drop FK constraints from business tables to users
ALTER TABLE IF EXISTS public.creators DROP CONSTRAINT IF EXISTS creators_user_id_fkey;
ALTER TABLE IF EXISTS public.hotel_profiles DROP CONSTRAINT IF EXISTS hotel_profiles_user_id_fkey;
ALTER TABLE IF EXISTS public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_sender_id_fkey;

-- Drop auth tables (order matters due to FKs between them)
DROP TABLE IF EXISTS public.gdpr_requests CASCADE;
DROP TABLE IF EXISTS public.consent_history CASCADE;
DROP TABLE IF EXISTS public.cookie_consent CASCADE;
DROP TABLE IF EXISTS public.email_verification_tokens CASCADE;
DROP TABLE IF EXISTS public.email_verification_codes CASCADE;
DROP TABLE IF EXISTS public.password_reset_tokens CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
