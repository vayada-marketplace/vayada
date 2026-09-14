CREATE TABLE pms.guest_review_submissions (
  property_id uuid NOT NULL REFERENCES hotel_catalog.properties(id),
  external_property_id text NOT NULL,
  provider_review_id text NOT NULL,
  attempt_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  guest_name text NOT NULL,
  reservation_code text NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted', 'failed', 'uncertain')),
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, provider_review_id)
);
