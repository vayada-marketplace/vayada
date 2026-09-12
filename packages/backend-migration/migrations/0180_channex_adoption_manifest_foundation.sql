-- Migration: 0180_channex_adoption_manifest_foundation
-- Owner: migration-cutover / VAY-1962
-- See: engineering/channex-property-adoption-proof-contract.md

CREATE TABLE platform.channex_adoption_approval_records (
  approval_record_id       UUID        PRIMARY KEY,
  manifest_id              UUID        NOT NULL,
  environment              TEXT        NOT NULL
                                        CHECK (environment IN ('local', 'staging', 'preprod', 'production')),
  expires_at               TIMESTAMPTZ NOT NULL,
  authority                TEXT        NOT NULL
                                        CHECK (authority IN ('migration_owner', 'security_owner')),
  actor_user_id            UUID        NOT NULL REFERENCES identity.users(id),
  approved_at              TIMESTAMPTZ NOT NULL,
  approval_subject_sha256  CHAR(64)    NOT NULL
                                        CHECK (approval_subject_sha256 ~ '^[0-9a-f]{64}$'),
  registry_revision        INTEGER     NOT NULL CHECK (registry_revision > 0),
  row_state_sha256         CHAR(64)    NOT NULL
                                        CHECK (row_state_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_channex_adoption_approval_authority UNIQUE (manifest_id, authority),
  CONSTRAINT uq_channex_adoption_approval_actor UNIQUE (manifest_id, actor_user_id),
  CONSTRAINT chk_channex_adoption_approval_window CHECK (approved_at <= expires_at)
);

CREATE TABLE platform.channex_adoption_approval_revocations (
  approval_record_id  UUID        PRIMARY KEY
                                  REFERENCES platform.channex_adoption_approval_records(approval_record_id),
  revoked_by_user_id  UUID        NOT NULL REFERENCES identity.users(id),
  revoked_at          TIMESTAMPTZ NOT NULL,
  reason_sha256       CHAR(64)    NOT NULL CHECK (reason_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.channex_adoption_manifest_consumptions (
  manifest_id             UUID        PRIMARY KEY,
  payload_sha256          CHAR(64)    NOT NULL UNIQUE CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  contract_version        TEXT        NOT NULL CHECK (contract_version = 'channex-property-adoption.v1'),
  environment             TEXT        NOT NULL
                                       CHECK (environment IN ('local', 'staging', 'preprod', 'production')),
  source_environment      TEXT        NOT NULL
                                       CHECK (source_environment IN ('local', 'staging', 'preprod')),
  source_run_id           TEXT        NOT NULL CHECK (source_run_id ~ '^vay1351-[0-9a-f]{24}$'),
  legacy_pms_hotel_id     UUID        NOT NULL,
  external_property_id    UUID        NOT NULL,
  target_property_id      UUID        NOT NULL,
  target_organization_id  UUID        NOT NULL,
  signing_key_id          TEXT        NOT NULL
                                       CHECK (signing_key_id ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$'),
  signature_algorithm     TEXT        NOT NULL CHECK (signature_algorithm = 'ed25519'),
  detached_signature      BYTEA       NOT NULL CHECK (octet_length(detached_signature) = 64),
  signature_verified      BOOLEAN     NOT NULL,
  outcome                 TEXT        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  claim_id                UUID        UNIQUE REFERENCES pms.channel_binding_claims(id),
  failure_code            TEXT        CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  retention_class         TEXT        NOT NULL DEFAULT 'security' CHECK (retention_class = 'security'),
  privacy_scope           TEXT        NOT NULL DEFAULT 'restricted' CHECK (privacy_scope = 'restricted'),
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  retained_until          TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 years'),
  CONSTRAINT chk_channex_adoption_consumption_result CHECK (
    (outcome = 'succeeded' AND signature_verified AND claim_id IS NOT NULL AND failure_code IS NULL)
    OR
    (outcome = 'failed' AND claim_id IS NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT chk_channex_adoption_consumption_retention
    CHECK (retained_until >= recorded_at + INTERVAL '7 years')
);

CREATE TRIGGER trg_channex_adoption_approvals_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_approval_records
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_approvals_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_approval_records
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_channex_adoption_revocations_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_revocations_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_approval_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER trg_channex_adoption_consumptions_append_only
  BEFORE UPDATE OR DELETE ON platform.channex_adoption_manifest_consumptions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER trg_channex_adoption_consumptions_protect_truncate
  BEFORE TRUNCATE ON platform.channex_adoption_manifest_consumptions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

REVOKE ALL ON platform.channex_adoption_approval_records FROM PUBLIC;
REVOKE ALL ON platform.channex_adoption_approval_revocations FROM PUBLIC;
REVOKE ALL ON platform.channex_adoption_manifest_consumptions FROM PUBLIC;
