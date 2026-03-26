-- Email change verification tokens
CREATE TABLE IF NOT EXISTS public.email_change_tokens (
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    new_email text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT email_change_tokens_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_token ON public.email_change_tokens (token);
CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user_id ON public.email_change_tokens (user_id);
