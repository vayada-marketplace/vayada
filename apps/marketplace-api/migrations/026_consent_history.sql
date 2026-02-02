-- ============================================
-- Create consent history audit trail table
-- ============================================
-- Maintains a complete audit trail of all consent actions.
-- Required for GDPR compliance to prove consent was given.

CREATE TABLE public.consent_history (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    consent_type text NOT NULL,
    consent_given boolean NOT NULL,
    version text,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Index for faster lookups by user_id
CREATE INDEX idx_consent_history_user_id ON public.consent_history(user_id);

-- Index for faster lookups by consent_type
CREATE INDEX idx_consent_history_consent_type ON public.consent_history(consent_type);

-- Index for time-based queries
CREATE INDEX idx_consent_history_created_at ON public.consent_history(created_at);

COMMENT ON TABLE public.consent_history IS 'Audit trail of all consent actions for GDPR compliance';
COMMENT ON COLUMN public.consent_history.consent_type IS 'Type of consent: terms, privacy, marketing, cookies';
COMMENT ON COLUMN public.consent_history.consent_given IS 'Whether consent was given (true) or withdrawn (false)';
COMMENT ON COLUMN public.consent_history.version IS 'Version of the document/policy consented to';
COMMENT ON COLUMN public.consent_history.ip_address IS 'IP address at the time of consent (for audit purposes)';
COMMENT ON COLUMN public.consent_history.user_agent IS 'User agent string at the time of consent';

-- ============================================
-- Create GDPR data requests table
-- ============================================
-- Tracks data export and deletion requests.

CREATE TABLE public.gdpr_requests (
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

-- Index for faster lookups by user_id
CREATE INDEX idx_gdpr_requests_user_id ON public.gdpr_requests(user_id);

-- Index for status-based queries
CREATE INDEX idx_gdpr_requests_status ON public.gdpr_requests(status);

-- Index for download token lookups
CREATE INDEX idx_gdpr_requests_download_token ON public.gdpr_requests(download_token);

COMMENT ON TABLE public.gdpr_requests IS 'Tracks GDPR data export and deletion requests';
COMMENT ON COLUMN public.gdpr_requests.request_type IS 'Type of request: export (Art. 20) or deletion (Art. 17)';
COMMENT ON COLUMN public.gdpr_requests.status IS 'Current status: pending, processing, completed, cancelled, expired';
COMMENT ON COLUMN public.gdpr_requests.expires_at IS 'For exports: when download link expires. For deletions: when deletion will be executed.';
COMMENT ON COLUMN public.gdpr_requests.download_token IS 'Secure token for downloading exported data';
