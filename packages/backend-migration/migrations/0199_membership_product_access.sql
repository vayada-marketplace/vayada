-- VAY-1439: membership restrictions are independent of subscription entitlements.
-- Compatibility defaults preserve existing access while writers are upgraded.
ALTER TABLE identity.organization_memberships
  ADD COLUMN pms_access_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN booking_access_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE identity.staff_invitations
  ADD COLUMN pms_access_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN booking_access_enabled BOOLEAN NOT NULL DEFAULT true;
