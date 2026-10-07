-- VAY-965: hold organization and assignment locks for the creation transaction.
-- No login or base-table write grant is introduced.
CREATE FUNCTION platform.hotel_setup_creation_assigned_organization()
RETURNS UUID LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assigned_organization UUID;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN NULL; END IF;
  SELECT scope.organization_id INTO assigned_organization
  FROM platform.hotel_setup_creation_scopes scope
  JOIN identity.organizations organization ON organization.id = scope.organization_id
  WHERE scope.database_login = session_user
    AND organization.kind = 'hotel_group' AND organization.status = 'active'
  FOR UPDATE OF organization FOR SHARE OF scope;
  RETURN assigned_organization;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_creation_assigned_organization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_creation_assigned_organization()
  TO vayada_next_hotel_setup_scope;

CREATE OR REPLACE FUNCTION platform.hotel_setup_new_property_allowed(requested_property_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assigned_organization UUID;
BEGIN
  assigned_organization := platform.hotel_setup_creation_assigned_organization();
  IF assigned_organization IS NULL THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM hotel_catalog.properties property
    WHERE property.id = requested_property_id
      AND property.creation_organization_id = assigned_organization
      AND property.xmin = pg_current_xact_id()::xid
      AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id)
  );
END $$;
