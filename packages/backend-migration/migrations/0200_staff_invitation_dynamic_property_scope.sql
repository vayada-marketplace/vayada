-- VAY-1439: Agency staff can receive all current and future organization properties.
ALTER TABLE identity.staff_invitations
  DROP CONSTRAINT staff_invitations_property_access_mode_check,
  ADD CONSTRAINT staff_invitations_property_access_mode_check
    CHECK (property_access_mode IN ('assigned', 'all'));
