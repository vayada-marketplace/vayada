-- ============================================
-- Create cookie consent table
-- ============================================
-- Stores cookie consent preferences for both anonymous visitors and logged-in users.
-- Required for GDPR/ePrivacy compliance.

CREATE TABLE public.cookie_consent (
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

-- Index for faster lookups by visitor_id
CREATE INDEX idx_cookie_consent_visitor_id ON public.cookie_consent(visitor_id);

-- Index for faster lookups by user_id
CREATE INDEX idx_cookie_consent_user_id ON public.cookie_consent(user_id);

COMMENT ON TABLE public.cookie_consent IS 'Stores cookie consent preferences for GDPR compliance';
COMMENT ON COLUMN public.cookie_consent.visitor_id IS 'Unique identifier for anonymous visitors (generated client-side)';
COMMENT ON COLUMN public.cookie_consent.user_id IS 'Reference to logged-in user (nullable for anonymous visitors)';
COMMENT ON COLUMN public.cookie_consent.necessary IS 'Essential cookies - always true, cannot be disabled';
COMMENT ON COLUMN public.cookie_consent.functional IS 'Cookies for enhanced features and preferences';
COMMENT ON COLUMN public.cookie_consent.analytics IS 'Cookies for usage analytics and statistics';
COMMENT ON COLUMN public.cookie_consent.marketing IS 'Cookies for personalized advertising';
