-- ============================================
-- Add GDPR consent fields to users table
-- ============================================
-- These fields track user consent for terms, privacy policy, and marketing.
-- Required for GDPR compliance in Germany/EU.

ALTER TABLE public.users
ADD COLUMN terms_accepted_at timestamp with time zone,
ADD COLUMN privacy_accepted_at timestamp with time zone,
ADD COLUMN terms_version text,
ADD COLUMN privacy_version text,
ADD COLUMN marketing_consent boolean DEFAULT false,
ADD COLUMN marketing_consent_at timestamp with time zone;

COMMENT ON COLUMN public.users.terms_accepted_at IS 'Timestamp when user accepted Terms of Service';
COMMENT ON COLUMN public.users.privacy_accepted_at IS 'Timestamp when user accepted Privacy Policy';
COMMENT ON COLUMN public.users.terms_version IS 'Version of Terms of Service accepted (e.g., "2024-01-15")';
COMMENT ON COLUMN public.users.privacy_version IS 'Version of Privacy Policy accepted (e.g., "2024-01-15")';
COMMENT ON COLUMN public.users.marketing_consent IS 'Whether user consented to marketing communications';
COMMENT ON COLUMN public.users.marketing_consent_at IS 'Timestamp when marketing consent was given/withdrawn';
