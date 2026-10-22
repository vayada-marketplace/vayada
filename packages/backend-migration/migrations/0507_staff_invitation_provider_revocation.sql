-- Migration: 0507_staff_invitation_provider_revocation
-- Owner: domain-identity (backend-auth)
-- See: engineering/staff-access-authorization-contract.md, VAY-2274
--
-- Team "Resend" revokes the replaced intent in Vayada at once. Its WorkOS invitation is revoked once
-- the replacement is delivered. provider_revoked_at records that WorkOS confirmed it (revoked, or no
-- longer pending); until then the identity provider worker retries, at most every five minutes,
-- until it lands or the invitation expires. provider_revoke_attempted_at is the retry lease.

ALTER TABLE identity.staff_invitations
  ADD COLUMN provider_revoked_at TIMESTAMPTZ,
  ADD COLUMN provider_revoke_attempted_at TIMESTAMPTZ;

CREATE INDEX ix_staff_invitations_provider_revocation_due
  ON identity.staff_invitations (provider_revoke_attempted_at NULLS FIRST, id)
  WHERE status = 'revoked' AND provider_invitation_id IS NOT NULL AND provider_revoked_at IS NULL;
