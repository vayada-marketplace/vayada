-- ============================================
-- Contact Form Submissions Table
-- ============================================
-- Stores contact form submissions from the website

CREATE TABLE public.contact_submissions (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),

  -- Contact info
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  country text,
  user_type text,
  message text NOT NULL,

  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT contact_submissions_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_contact_submissions_email ON public.contact_submissions(email);
CREATE INDEX idx_contact_submissions_created_at ON public.contact_submissions(created_at);

-- Comments
COMMENT ON TABLE public.contact_submissions IS 'Contact form submissions from the website';
COMMENT ON COLUMN public.contact_submissions.user_type IS 'Type of user: hotel, creator, or other';
