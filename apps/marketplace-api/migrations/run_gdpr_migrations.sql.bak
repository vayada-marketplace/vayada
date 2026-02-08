-- ============================================
-- GDPR Compliance Migrations (024-027)
-- Run this in AWS RDS Query Editor
-- ============================================

-- Migration 024: Add consent fields to users table
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS privacy_accepted_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS terms_version text,
ADD COLUMN IF NOT EXISTS privacy_version text,
ADD COLUMN IF NOT EXISTS marketing_consent boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS marketing_consent_at timestamp with time zone;

-- Migration 025: Create cookie_consent table
CREATE TABLE IF NOT EXISTS public.cookie_consent (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    visitor_id text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    necessary boolean DEFAULT true NOT NULL,
    functional boolean DEFAULT false NOT NULL,
    analytics boolean DEFAULT false NOT NULL,
    marketing boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_visitor_id ON public.cookie_consent(visitor_id);
CREATE INDEX IF NOT EXISTS idx_cookie_consent_user_id ON public.cookie_consent(user_id);

-- Migration 026: Create consent_history table
CREATE TABLE IF NOT EXISTS public.consent_history (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    consent_type text NOT NULL,
    consent_given boolean NOT NULL,
    version text,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_history_user_id ON public.consent_history(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_history_consent_type ON public.consent_history(consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_history_created_at ON public.consent_history(created_at);

-- Migration 026: Create gdpr_requests table
CREATE TABLE IF NOT EXISTS public.gdpr_requests (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid REFERENCES users(id) ON DELETE SET NULL NOT NULL,
    request_type text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    expires_at timestamp with time zone,
    download_token text,
    cancellation_reason text,
    ip_address text,
    CONSTRAINT valid_request_type CHECK (request_type IN ('export', 'deletion')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_gdpr_requests_user_id ON public.gdpr_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_status ON public.gdpr_requests(status);
CREATE INDEX IF NOT EXISTS idx_gdpr_requests_download_token ON public.gdpr_requests(download_token);

-- Migration 027: Backfill existing users with consent timestamps
UPDATE public.users
SET
    terms_accepted_at = created_at,
    privacy_accepted_at = created_at,
    terms_version = '2024-01-01',
    privacy_version = '2024-01-01'
WHERE terms_accepted_at IS NULL;

-- Done!
SELECT 'GDPR migrations completed successfully!' as status;
