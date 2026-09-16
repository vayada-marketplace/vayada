-- VAY-1439: External owners use the existing invitation lifecycle and saved roles.
-- Existing rows are unchanged. Deploy readers before enabling the new writer.
ALTER TABLE identity.staff_invitations DROP CONSTRAINT staff_invitations_role_key_check;
ALTER TABLE identity.staff_invitations ADD CONSTRAINT staff_invitations_role_key_check
  CHECK (role_key IN ('hotel_manager', 'front_desk', 'housekeeping', 'hotel_custom', 'external_owner'));
ALTER TABLE identity.staff_invitations ADD CONSTRAINT staff_invitations_external_owner_scope
  CHECK (role_key <> 'external_owner' OR (property_access_mode = 'assigned' AND (status <> 'pending' OR role_definition_id IS NOT NULL)));
