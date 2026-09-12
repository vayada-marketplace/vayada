-- PMS-owned inclusion declaration; not calculated tax or additive-charge evidence.
CREATE TABLE pms.pricing_v2_charge_declarations (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  declaration TEXT NOT NULL CHECK (declaration='all_mandatory_charges_included'),
  draft_id UUID NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision>0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(property_id,request_id)
);
CREATE TRIGGER pricing_v2_charge_declarations_immutable BEFORE UPDATE OR DELETE ON pms.pricing_v2_charge_declarations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_v2_charge_declarations_no_truncate BEFORE TRUNCATE ON pms.pricing_v2_charge_declarations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
