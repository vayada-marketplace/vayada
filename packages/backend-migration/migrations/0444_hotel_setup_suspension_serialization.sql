-- VAY-1092: serialize setup with FK-backed entitlement inserts, including
-- new suspensions. This stages the lock protocol, not activation or grants.
CREATE OR REPLACE FUNCTION platform.hotel_setup_property_allowed(
  requested_property_id UUID, requested_organization_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assignment RECORD;
BEGIN
  -- A snapshot taken before the lock could miss a newly committed suspension.
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN FALSE; END IF;
  SELECT scope.property_id, scope.organization_id INTO assignment
  FROM platform.hotel_setup_property_scopes scope
  JOIN identity.organizations organization ON organization.id = scope.organization_id
  WHERE scope.database_login = session_user AND scope.active
    AND scope.property_id = requested_property_id
    AND (requested_organization_id IS NULL OR scope.organization_id = requested_organization_id)
    AND organization.kind = 'hotel_group' AND organization.status = 'active'
  -- ponytail: organization-wide setup lock; use a separate suspension gate only if contention requires it.
  FOR UPDATE OF organization FOR SHARE OF scope;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM identity.organization_resource_links catalog_link
    JOIN identity.organization_resource_links pms_link
      ON pms_link.organization_id = catalog_link.organization_id
      AND pms_link.product = 'pms' AND pms_link.resource_type = 'pms_property'
      AND platform.hotel_setup_property_link_matches(requested_property_id, pms_link.resource_id)
      AND pms_link.relationship = 'owner' AND pms_link.status = 'active'
    WHERE catalog_link.organization_id = assignment.organization_id
      AND catalog_link.product = 'hotel_catalog' AND catalog_link.resource_type = 'property'
      AND platform.hotel_setup_property_link_matches(requested_property_id, catalog_link.resource_id)
      AND catalog_link.relationship = 'owner' AND catalog_link.status = 'active'
    FOR SHARE OF catalog_link, pms_link
  );
END $$;
