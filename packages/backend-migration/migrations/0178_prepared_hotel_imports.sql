-- Immutable invitation content is the source. This row binds its application
-- to one property and records successful items independently of acceptance.
CREATE TABLE hotel_catalog.prepared_import_applications (
  invite_id UUID PRIMARY KEY REFERENCES marketplace.invite_codes(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  results JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
