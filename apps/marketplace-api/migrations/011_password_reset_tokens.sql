-- ============================================
-- Password Reset Tokens Table
-- ============================================
-- Stores password reset tokens for forgot password functionality
-- Tokens expire after 1 hour and can only be used once

CREATE TABLE public.password_reset_tokens (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  
  -- Token data
  token text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_password_reset_tokens_user_id ON public.password_reset_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_token ON public.password_reset_tokens(token);
CREATE INDEX idx_password_reset_tokens_expires_at ON public.password_reset_tokens(expires_at);

-- Comments
COMMENT ON TABLE public.password_reset_tokens IS 'Password reset tokens for forgot password functionality. Tokens expire after 1 hour and can only be used once.';
COMMENT ON COLUMN public.password_reset_tokens.token IS 'Unique secure token for password reset';
COMMENT ON COLUMN public.password_reset_tokens.expires_at IS 'Token expiration timestamp (typically 1 hour from creation)';
COMMENT ON COLUMN public.password_reset_tokens.used IS 'Whether the token has been used to reset password';


