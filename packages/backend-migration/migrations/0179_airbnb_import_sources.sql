-- OAuth correlation and immutable listing snapshots; not invitation redemption.
CREATE TABLE hotel_catalog.airbnb_import_sources (
  id UUID PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  external_group_id UUID NOT NULL,
  external_property_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '20 minutes'),
  channel_id UUID,
  prepared_data JSONB,
  completed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (
    (channel_id IS NULL AND prepared_data IS NULL AND completed_at IS NULL) OR
    (channel_id IS NOT NULL AND prepared_data IS NOT NULL AND completed_at IS NOT NULL
      AND jsonb_typeof(prepared_data) = 'object')
  ),
  UNIQUE (environment, channel_id)
);

CREATE INDEX airbnb_import_sources_pending_expiry
  ON hotel_catalog.airbnb_import_sources(expires_at) WHERE completed_at IS NULL;
