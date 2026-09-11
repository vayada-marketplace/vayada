-- VAY-1506. Non-earning probe identities only; no capability result or live link.
-- Contract: engineering/affiliate-referral-validation.md
ALTER TABLE booking.affiliate_destination_versions
  ADD CONSTRAINT affiliate_destination_author_scope UNIQUE(id, property_id, created_by_organization_id);
CREATE TABLE booking.affiliate_validation_probes (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  destination_version_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  purpose TEXT NOT NULL DEFAULT 'validation' CHECK (purpose='validation'),
  environment TEXT NOT NULL CHECK (environment IN ('local','sandbox')),
  connection_reference TEXT NOT NULL CHECK (length(btrim(connection_reference)) BETWEEN 1 AND 200),
  adapter_version TEXT NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 100),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  expires_at TIMESTAMPTZ NOT NULL CHECK (isfinite(expires_at)),
  CHECK (expires_at > recorded_at AND expires_at <= recorded_at + interval '24 hours'),
  UNIQUE(property_id, key_hash),
  FOREIGN KEY(destination_version_id,property_id,organization_id)
    REFERENCES booking.affiliate_destination_versions(id,property_id,created_by_organization_id)
);
CREATE TABLE booking.affiliate_validation_probe_revocations (
  probe_id UUID PRIMARY KEY REFERENCES booking.affiliate_validation_probes(id),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at))
);
CREATE TRIGGER affiliate_validation_probe_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_validation_probes
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_validation_probe_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_validation_probes
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_validation_probe_revocation_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_validation_probe_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_validation_probe_revocation_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_validation_probe_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
COMMENT ON TABLE booking.affiliate_validation_probes IS
  'Immutable non-earning local/sandbox probe issuance audit. No guest, creator, agreement, booking or readiness result.';
