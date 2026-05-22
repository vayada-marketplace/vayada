-- ============================================
-- Admin 2FA: TOTP secrets, recovery codes,
-- login audit log, and rate limiting
-- ============================================

-- TOTP secrets (one row per user, replaced on re-enrollment)
CREATE TABLE IF NOT EXISTS public.totp_secrets (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    secret_encrypted text NOT NULL,
    enrolled boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT totp_secrets_pkey PRIMARY KEY (id),
    CONSTRAINT totp_secrets_user_id_key UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_totp_secrets_user_id ON public.totp_secrets(user_id);

-- Recovery codes (up to 10 per enrollment, bcrypt-hashed)
CREATE TABLE IF NOT EXISTS public.totp_recovery_codes (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    used boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT totp_recovery_codes_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_totp_recovery_codes_user_id
    ON public.totp_recovery_codes(user_id)
    WHERE used = false;

-- Login audit log (append-only)
CREATE TABLE IF NOT EXISTS public.login_audit_log (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    email text NOT NULL,
    success boolean NOT NULL,
    auth_method text,
    failure_reason text,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT login_audit_log_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_login_audit_log_user_id
    ON public.login_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_log_email
    ON public.login_audit_log(email, created_at DESC);

-- Rate limiting (one row per email, upserted on each failed attempt)
CREATE TABLE IF NOT EXISTS public.login_rate_limit (
    email text NOT NULL,
    failed_attempts integer NOT NULL DEFAULT 0,
    locked_until timestamp with time zone,
    last_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT login_rate_limit_pkey PRIMARY KEY (email)
);
