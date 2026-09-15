-- VAY-2017: engineering/legacy-owner-account-setup.md
-- Storage only. No grants to an executor, identity writes, or signup changes.
CREATE FUNCTION platform.valid_bootstrap_owner_ids(ids UUID[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT cardinality(ids) BETWEEN 1 AND 8
    AND array_ndims(ids) = 1 AND array_lower(ids, 1) = 1
    AND array_position(ids, NULL) IS NULL
    AND ids = ARRAY(SELECT DISTINCT owner_id FROM unnest(ids) AS owner_id ORDER BY owner_id)
$$;

CREATE TABLE platform.legacy_owner_bootstrap_receipts (
  command_id UUID PRIMARY KEY,
  contract_version TEXT NOT NULL CHECK (contract_version = 'legacy-owner-internal-setup.v1'),
  environment TEXT NOT NULL CHECK (environment IN ('local','staging','preprod','production')),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  owner_user_ids UUID[] NOT NULL CHECK (platform.valid_bootstrap_owner_ids(owner_user_ids)),
  source_run_id TEXT NOT NULL CHECK (source_run_id ~ '^vay1351-[0-9a-f]{24}$'),
  source_evidence_sha256 TEXT NOT NULL CHECK (source_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  target_before_sha256 TEXT NOT NULL CHECK (target_before_sha256 ~ '^[0-9a-f]{64}$'),
  target_after_sha256 TEXT NOT NULL CHECK (target_after_sha256 ~ '^[0-9a-f]{64}$'),
  approval_envelope_sha256 TEXT NOT NULL CHECK (approval_envelope_sha256 ~ '^[0-9a-f]{64}$'),
  executor_principal_sha256 TEXT NOT NULL CHECK (executor_principal_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint TEXT NOT NULL CHECK (checkpoint = 'internal_users_prepared'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at))
);
CREATE TRIGGER bootstrap_receipts_append_only
  BEFORE UPDATE OR DELETE ON platform.legacy_owner_bootstrap_receipts
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER bootstrap_receipts_no_truncate
  BEFORE TRUNCATE ON platform.legacy_owner_bootstrap_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
REVOKE ALL ON platform.legacy_owner_bootstrap_receipts FROM PUBLIC;
