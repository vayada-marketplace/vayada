-- VAY-1092: an organization setup login may only create a pending Financials
-- row for a newly created PMS property it owns. Runtime grants come later.
CREATE FUNCTION platform.hotel_setup_pending_financials_allowed(
  organization_id UUID, resource_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
    FROM platform.hotel_setup_creation_scopes scope
    JOIN identity.organizations organization ON organization.id = scope.organization_id
    JOIN hotel_catalog.properties property
      ON property.id::text = $2 AND property.creation_organization_id = scope.organization_id
    JOIN identity.organization_resource_links catalog_link
      ON catalog_link.organization_id = scope.organization_id
      AND catalog_link.product = 'hotel_catalog'
      AND catalog_link.resource_type = 'property'
      AND catalog_link.resource_id = $2
      AND catalog_link.relationship = 'owner'
      AND catalog_link.status = 'active'
    JOIN identity.organization_resource_links pms_link
      ON pms_link.organization_id = scope.organization_id
      AND pms_link.product = 'pms'
      AND pms_link.resource_type = 'pms_property'
      AND pms_link.resource_id = $2
      AND pms_link.relationship = 'owner'
      AND pms_link.status = 'active'
    WHERE scope.database_login = session_user
      AND scope.organization_id = $1
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
  );
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_pending_financials_allowed(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_pending_financials_allowed(UUID, TEXT)
  TO vayada_next_hotel_setup_scope;

CREATE POLICY hotel_setup_entitlement_read_guard ON identity.product_entitlements
  AS RESTRICTIVE FOR SELECT TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_entitlement_read_scope ON identity.product_entitlements
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (
    EXISTS (
      SELECT 1 FROM hotel_catalog.hotel_setup_effective_creation_scopes scope
      WHERE scope.organization_id = product_entitlements.organization_id
    )
    AND (
      (resource_product IS NULL AND resource_type IS NULL AND resource_id IS NULL
        AND (product, entitlement_key) IN (
          ('booking', 'booking-engine'), ('pms', 'property-management'),
          ('marketplace', 'marketplace-hotel-profile')))
      OR (product = 'pms' AND entitlement_key = 'module:financials'
        AND resource_product = 'pms' AND resource_type = 'pms_property'
        AND platform.hotel_setup_pending_financials_allowed(organization_id, resource_id))
    )
  );

CREATE POLICY hotel_setup_entitlement_insert_guard ON identity.product_entitlements
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_entitlement_pending_insert ON identity.product_entitlements
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (
    product = 'pms' AND entitlement_key = 'module:financials'
    AND status = 'suspended' AND resource_product = 'pms'
    AND resource_type = 'pms_property'
    AND metadata = '{"newHotelFinancialsDefault":"pending"}'::jsonb
    AND starts_at IS NULL AND expires_at IS NULL
    AND platform.hotel_setup_pending_financials_allowed(organization_id, resource_id)
  );

CREATE POLICY hotel_setup_entitlement_update_denial ON identity.product_entitlements
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );
CREATE POLICY hotel_setup_entitlement_delete_denial ON identity.product_entitlements
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );
