-- VAY-1505: engineering/affiliate-booking-evidence-contract.md; no collection endpoint.
CREATE TABLE booking.affiliate_evidence_observations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 256),
  delivery_key TEXT NOT NULL UNIQUE CHECK (delivery_key ~ '^[0-9a-f]{64}$'),
  fact_digest TEXT NOT NULL CHECK (fact_digest ~ '^[0-9a-f]{64}$'),
  mapping_version TEXT NOT NULL CHECK (length(mapping_version) BETWEEN 1 AND 256),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(received_at)),
  UNIQUE (id, organization_id, property_id)
);
CREATE TABLE booking.affiliate_evidence_deliveries (
  id UUID PRIMARY KEY,
  observation_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  property_id UUID NOT NULL,
  fact_digest TEXT NOT NULL CHECK (fact_digest ~ '^[0-9a-f]{64}$'),
  mapping_version TEXT NOT NULL CHECK (length(mapping_version) BETWEEN 1 AND 256),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(received_at)),
  FOREIGN KEY (observation_id, organization_id, property_id)
    REFERENCES booking.affiliate_evidence_observations(id, organization_id, property_id)
);
CREATE INDEX affiliate_evidence_delivery_observation
  ON booking.affiliate_evidence_deliveries(observation_id);
CREATE TRIGGER affiliate_evidence_observation_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_evidence_observations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_evidence_observation_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_evidence_observations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_evidence_delivery_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_evidence_deliveries
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_evidence_delivery_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_evidence_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
