-- VAY-965: publication readiness, separate from active native proof authority.
-- No runtime login, business policy or privilege is changed by this migration.
ALTER TABLE platform.hotel_setup_creation_scopes
  ADD COLUMN credential_role_oid OID,
  ADD COLUMN credential_secret_version TEXT,
  ADD COLUMN credential_ready_at TIMESTAMPTZ,
  ADD CONSTRAINT hotel_setup_creation_credential_ready CHECK (
    (credential_role_oid IS NULL AND credential_secret_version IS NULL AND credential_ready_at IS NULL)
    OR (credential_role_oid IS NOT NULL AND credential_secret_version IS NOT NULL
      AND credential_secret_version ~ '^[A-Za-z0-9-]{32,64}$' AND credential_ready_at IS NOT NULL)
  );

ALTER TABLE platform.hotel_setup_property_scopes
  ADD COLUMN credential_role_oid OID,
  ADD COLUMN credential_secret_version TEXT,
  ADD COLUMN credential_ready_at TIMESTAMPTZ,
  ADD CONSTRAINT hotel_setup_property_credential_ready CHECK (
    (credential_role_oid IS NULL AND credential_secret_version IS NULL AND credential_ready_at IS NULL)
    OR (credential_role_oid IS NOT NULL AND credential_secret_version IS NOT NULL
      AND credential_secret_version ~ '^[A-Za-z0-9-]{32,64}$' AND credential_ready_at IS NOT NULL)
  );
