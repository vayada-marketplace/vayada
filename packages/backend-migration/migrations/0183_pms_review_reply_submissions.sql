CREATE TABLE pms.review_reply_submissions (
  review_id UUID PRIMARY KEY REFERENCES pms.channel_reviews(id),
  attempt_id UUID NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  state TEXT NOT NULL CHECK (state IN ('uncertain', 'accepted', 'failed')),
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
