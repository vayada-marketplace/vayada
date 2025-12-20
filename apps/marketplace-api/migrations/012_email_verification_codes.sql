-- ============================================
-- Email Verification Codes Table
-- ============================================
-- Stores verification codes sent to users during registration
-- Codes expire after a set time and can only be used once

CREATE TABLE IF NOT EXISTS public.email_verification_codes (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    email text NOT NULL,
    code text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT email_verification_codes_pkey PRIMARY KEY (id)
);

-- Indexes for faster lookups
CREATE INDEX idx_email_verification_codes_email ON public.email_verification_codes(email);
CREATE INDEX idx_email_verification_codes_code ON public.email_verification_codes(code);
CREATE INDEX idx_email_verification_codes_expires_at ON public.email_verification_codes(expires_at);
CREATE INDEX idx_email_verification_codes_email_code ON public.email_verification_codes(email, code) WHERE used = false;

-- Add email_verified column to users table
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Index for email verification status
CREATE INDEX IF NOT EXISTS idx_users_email_verified ON public.users(email_verified);

-- Comments
COMMENT ON TABLE public.email_verification_codes IS 'Stores email verification codes sent during registration';
COMMENT ON COLUMN public.email_verification_codes.email IS 'Email address to verify';
COMMENT ON COLUMN public.email_verification_codes.code IS '6-digit verification code';
COMMENT ON COLUMN public.email_verification_codes.expires_at IS 'When the code expires (typically 10-15 minutes)';
COMMENT ON COLUMN public.email_verification_codes.used IS 'Whether the code has been used';
COMMENT ON COLUMN public.users.email_verified IS 'Whether the user has verified their email address';


