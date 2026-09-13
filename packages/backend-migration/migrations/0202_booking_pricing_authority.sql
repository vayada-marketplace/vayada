-- Booking selects the pricing provider explicitly. Absence never implies Vayada.
CREATE TABLE booking.pricing_authority_revisions (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  revision UUID NOT NULL UNIQUE,
  authority TEXT NOT NULL CHECK (authority IN ('unconfigured','vayada','external')),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id,revision),
  UNIQUE (property_id,request_id)
);
CREATE TABLE booking.pricing_authority_heads (
  property_id UUID PRIMARY KEY,
  revision UUID NOT NULL,
  FOREIGN KEY (property_id,revision)
    REFERENCES booking.pricing_authority_revisions(property_id,revision)
);
CREATE TRIGGER pricing_authority_revisions_immutable BEFORE UPDATE OR DELETE ON booking.pricing_authority_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_authority_revisions_no_truncate BEFORE TRUNCATE ON booking.pricing_authority_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
