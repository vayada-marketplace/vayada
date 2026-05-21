-- ============================================
-- Email Verification Tokens Table
-- ============================================
-- Stores email verification tokens for verifying user emails after profile completion
-- Tokens expire after 48 hours and can only be used once

CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  
  -- Token data
  token text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON public.email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token ON public.email_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires_at ON public.email_verification_tokens(expires_at);

-- Comments
COMMENT ON TABLE public.email_verification_tokens IS 'Email verification tokens for verifying user emails after profile completion. Tokens expire after 48 hours and can only be used once.';
COMMENT ON COLUMN public.email_verification_tokens.token IS 'Unique secure token for email verification';
COMMENT ON COLUMN public.email_verification_tokens.expires_at IS 'Token expiration timestamp (typically 48 hours from creation)';
COMMENT ON COLUMN public.email_verification_tokens.used IS 'Whether the token has been used to verify email';

