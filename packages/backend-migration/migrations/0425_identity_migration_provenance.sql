-- VAY-2017: migration evidence only. Does not grant access or change identity status.
CREATE TABLE platform.identity_migration_provenance (
  source_run_id TEXT NOT NULL REFERENCES platform.source_extraction_runs(run_id),
  plan_sha256 TEXT NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  target_table TEXT NOT NULL CHECK (target_table IN (
    'identity.users', 'identity.organizations',
    'identity.organization_memberships', 'identity.organization_resource_links'
  )),
  target_id UUID NOT NULL,
  before_sha256 TEXT CHECK (before_sha256 ~ '^[0-9a-f]{64}$'),
  before_status TEXT,
  after_sha256 TEXT NOT NULL CHECK (after_sha256 ~ '^[0-9a-f]{64}$'),
  after_status TEXT NOT NULL,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (target_table, target_id, transaction_id),
  CHECK ((before_sha256 IS NULL) = (before_status IS NULL))
);

CREATE TRIGGER identity_migration_provenance_append_only
  BEFORE UPDATE OR DELETE ON platform.identity_migration_provenance
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER identity_migration_provenance_no_truncate
  BEFORE TRUNCATE ON platform.identity_migration_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
REVOKE ALL ON platform.identity_migration_provenance FROM PUBLIC;
