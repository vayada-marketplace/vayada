-- VAY-2017: engineering/legacy-pms-ownership-restoration.md
-- Separate from clean Channex adoption. No product access or runtime grants.
CREATE TABLE platform.legacy_owner_approval_records (
  approval_record_id UUID PRIMARY KEY,
  command_id UUID NOT NULL,
  contract_version TEXT NOT NULL CHECK (contract_version = 'legacy-pms-owner-evidence.v1'),
  environment TEXT NOT NULL CHECK (environment IN ('local', 'staging', 'preprod', 'production')),
  envelope_sha256 TEXT NOT NULL CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  authority TEXT NOT NULL CHECK (authority IN ('migration_owner', 'security_owner')),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  approved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (command_id, authority),
  CHECK (isfinite(approved_at) AND isfinite(expires_at) AND approved_at < expires_at),
  CHECK (approved_at = date_trunc('milliseconds', approved_at)
    AND expires_at = date_trunc('milliseconds', expires_at))
);
-- One person may hold both authorities, but each has its own immutable row.
CREATE TABLE platform.legacy_owner_approval_revocations (
  approval_record_id UUID PRIMARY KEY REFERENCES platform.legacy_owner_approval_records(approval_record_id),
  revoked_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  revoked_at TIMESTAMPTZ NOT NULL CHECK (isfinite(revoked_at)),
  reason_sha256 TEXT NOT NULL CHECK (reason_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER legacy_owner_approvals_append_only
  BEFORE UPDATE OR DELETE ON platform.legacy_owner_approval_records
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER legacy_owner_approvals_no_truncate
  BEFORE TRUNCATE ON platform.legacy_owner_approval_records
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER legacy_owner_revocations_append_only
  BEFORE UPDATE OR DELETE ON platform.legacy_owner_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER legacy_owner_revocations_no_truncate
  BEFORE TRUNCATE ON platform.legacy_owner_approval_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
REVOKE ALL ON platform.legacy_owner_approval_records FROM PUBLIC;
REVOKE ALL ON platform.legacy_owner_approval_revocations FROM PUBLIC;
