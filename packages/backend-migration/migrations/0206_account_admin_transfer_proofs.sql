-- VAY-1439: short-lived transfer intent and provider authentication evidence.
CREATE TABLE identity.account_admin_transfer_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  actor_membership_id UUID NOT NULL REFERENCES identity.organization_memberships(id) ON DELETE CASCADE,
  target_membership_id UUID NOT NULL REFERENCES identity.organization_memberships(id) ON DELETE CASCADE,
  workos_user_id TEXT NOT NULL CHECK (btrim(workos_user_id) <> ''),
  workos_org_id TEXT NOT NULL CHECK (btrim(workos_org_id) <> ''),
  source_session_id TEXT NOT NULL CHECK (btrim(source_session_id) <> ''),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state_digest TEXT NOT NULL UNIQUE CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  verified_session_id TEXT,
  authenticated_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + interval '5 minutes',
  CHECK (actor_membership_id <> target_membership_id),
  CHECK ((verified_session_id IS NULL) = (authenticated_at IS NULL)),
  CHECK (verified_session_id IS NULL OR btrim(verified_session_id) <> ''),
  CHECK (consumed_at IS NULL OR authenticated_at IS NOT NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '301 seconds')
);
CREATE INDEX account_admin_transfer_proofs_expiry ON identity.account_admin_transfer_proofs (expires_at);
