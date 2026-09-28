-- VAY-2017: engineering/legacy-pms-ownership-restoration.md
-- Restricted evidence storage only: no claim/connection writer or executor grants.
CREATE TABLE platform.legacy_historical_binding_transitions (
  command_id UUID PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = 'legacy-historical-binding-transition.v1'),
  environment TEXT NOT NULL CHECK (environment IN ('local','staging','preprod','production')),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('prepare','compensate')),
  compensates_command_id UUID UNIQUE REFERENCES platform.legacy_historical_binding_transitions(command_id),
  claim_id UUID NOT NULL REFERENCES pms.channel_binding_claims(id),
  property_id UUID NOT NULL,
  external_property_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'channex'),
  claim_source TEXT NOT NULL CHECK (claim_source = 'migration'),
  claim_created_at TIMESTAMPTZ NOT NULL CHECK (isfinite(claim_created_at)),
  source_run_id TEXT NOT NULL CHECK (source_run_id ~ '^vay1351-[0-9a-f]{24}$'),
  source_active BOOLEAN NOT NULL CHECK (source_active),
  source_evidence_sha256 TEXT NOT NULL CHECK (source_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  target_before_sha256 TEXT NOT NULL CHECK (target_before_sha256 ~ '^[0-9a-f]{64}$'),
  target_after_sha256 TEXT NOT NULL CHECK (target_after_sha256 ~ '^[0-9a-f]{64}$'),
  approval_envelope_sha256 TEXT NOT NULL CHECK (approval_envelope_sha256 ~ '^[0-9a-f]{64}$'),
  executor_principal_sha256 TEXT NOT NULL CHECK (executor_principal_sha256 ~ '^[0-9a-f]{64}$'),
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  CHECK ((event_kind = 'prepare' AND compensates_command_id IS NULL
    AND before_state = 'historical' AND after_state = 'verified_non_active')
    OR (event_kind = 'compensate' AND compensates_command_id IS NOT NULL
    AND before_state = 'verified_non_active' AND after_state = 'historical')),
  CHECK (compensates_command_id IS DISTINCT FROM command_id),
  CHECK (property_id::text NOT IN ('17621565-40b5-4ebc-8727-3a301ac947a2',
    '46906724-72cb-4acf-a2eb-b740a3bdbcf7','65f6b2fc-c783-4963-9d6b-a85f82319769',
    '8f4c1e47-3de1-4150-8bde-ad031a013842')
    AND external_property_id::text NOT IN ('17621565-40b5-4ebc-8727-3a301ac947a2',
    '46906724-72cb-4acf-a2eb-b740a3bdbcf7','65f6b2fc-c783-4963-9d6b-a85f82319769',
    '8f4c1e47-3de1-4150-8bde-ad031a013842'))
);

-- A compensating event references an immutable prepare, never another compensation.
-- This validates stored lineage, not current ownership/claims, signatures or authority.
CREATE FUNCTION platform.validate_historical_binding_compensation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE original platform.legacy_historical_binding_transitions%ROWTYPE;
BEGIN
  IF NEW.event_kind = 'compensate' THEN
    SELECT * INTO original FROM platform.legacy_historical_binding_transitions
      WHERE command_id = NEW.compensates_command_id;
    IF NOT FOUND OR original.event_kind <> 'prepare'
      OR ROW(NEW.environment, NEW.claim_id, NEW.property_id, NEW.external_property_id,
        NEW.provider, NEW.claim_source, NEW.claim_created_at, NEW.source_run_id,
        NEW.source_evidence_sha256, NEW.target_before_sha256)
        IS DISTINCT FROM ROW(original.environment, original.claim_id, original.property_id,
        original.external_property_id, original.provider, original.claim_source,
        original.claim_created_at, original.source_run_id, original.source_evidence_sha256,
        original.target_after_sha256) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Historical binding compensation mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER historical_binding_compensation_lineage
  BEFORE INSERT ON platform.legacy_historical_binding_transitions
  FOR EACH ROW EXECUTE FUNCTION platform.validate_historical_binding_compensation();
CREATE TRIGGER historical_binding_transitions_append_only
  BEFORE UPDATE OR DELETE ON platform.legacy_historical_binding_transitions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER historical_binding_transitions_no_truncate
  BEFORE TRUNCATE ON platform.legacy_historical_binding_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
REVOKE ALL ON platform.legacy_historical_binding_transitions FROM PUBLIC;
