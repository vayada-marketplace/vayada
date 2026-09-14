-- Migration: 0186_channex_adoption_rollback_evidence
-- Owner: migration-cutover / VAY-1963
-- See: engineering/channex-property-adoption-proof-contract.md

ALTER TABLE platform.channex_adoption_approval_records
  DROP CONSTRAINT uq_channex_adoption_approval_actor;

CREATE TABLE platform.channex_adoption_rollback_approval_records (
  approval_record_id       UUID        PRIMARY KEY,
  manifest_id              UUID        NOT NULL
                                        REFERENCES platform.channex_adoption_manifest_consumptions(manifest_id),
  environment              TEXT        NOT NULL
                                        CHECK (environment IN ('local', 'staging', 'preprod', 'production')),
  expires_at               TIMESTAMPTZ NOT NULL,
  rollback_reason_sha256   CHAR(64)    NOT NULL
                                        CHECK (rollback_reason_sha256 ~ '^[0-9a-f]{64}$'),
  authority                TEXT        NOT NULL
                                        CHECK (authority IN ('migration_owner', 'security_owner')),
  actor_user_id            UUID        NOT NULL REFERENCES identity.users(id),
  approved_at              TIMESTAMPTZ NOT NULL,
  rollback_subject_sha256  CHAR(64)    NOT NULL
                                        CHECK (rollback_subject_sha256 ~ '^[0-9a-f]{64}$'),
  registry_revision        INTEGER     NOT NULL CHECK (registry_revision > 0),
  row_state_sha256         CHAR(64)    NOT NULL CHECK (row_state_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_channex_adoption_rollback_authority
    UNIQUE (rollback_subject_sha256, authority),
  CONSTRAINT chk_channex_adoption_rollback_approval_window CHECK (approved_at <= expires_at)
);

CREATE TABLE platform.channex_adoption_rollback_approval_revocations (
  approval_record_id UUID PRIMARY KEY
                          REFERENCES platform.channex_adoption_rollback_approval_records(approval_record_id),
  revoked_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  revoked_at TIMESTAMPTZ NOT NULL,
  reason_sha256 CHAR(64) NOT NULL CHECK (reason_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.channex_adoption_rollbacks (
  manifest_id UUID PRIMARY KEY
                   REFERENCES platform.channex_adoption_manifest_consumptions(manifest_id),
  claim_id UUID NOT NULL UNIQUE REFERENCES pms.channel_binding_claims(id),
  rollback_reason_sha256 CHAR(64) NOT NULL
                                  CHECK (rollback_reason_sha256 ~ '^[0-9a-f]{64}$'),
  rollback_subject_sha256 CHAR(64) NOT NULL
                                   CHECK (rollback_subject_sha256 ~ '^[0-9a-f]{64}$'),
  migration_approval_record_id UUID NOT NULL
    REFERENCES platform.channex_adoption_rollback_approval_records(approval_record_id),
  security_approval_record_id UUID NOT NULL
    REFERENCES platform.channex_adoption_rollback_approval_records(approval_record_id),
  released_at TIMESTAMPTZ NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'security' CHECK (retention_class = 'security'),
  privacy_scope TEXT NOT NULL DEFAULT 'restricted' CHECK (privacy_scope = 'restricted'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retained_until TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 years'),
  CONSTRAINT chk_channex_adoption_rollback_approvals_differ
    CHECK (migration_approval_record_id <> security_approval_record_id),
  CONSTRAINT chk_channex_adoption_rollback_retention
    CHECK (retained_until >= recorded_at + INTERVAL '7 years')
);

CREATE TRIGGER trg_channex_adoption_rollback_approvals_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_rollback_approval_records
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_rollback_approvals_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_rollback_approval_records
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_rollback_revocations_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_rollback_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_rollback_revocations_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_rollback_approval_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_rollbacks_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_rollbacks
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_rollbacks_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_rollbacks
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

REVOKE ALL ON platform.channex_adoption_rollback_approval_records FROM PUBLIC;
REVOKE ALL ON platform.channex_adoption_rollback_approval_revocations FROM PUBLIC;
REVOKE ALL ON platform.channex_adoption_rollbacks FROM PUBLIC;
