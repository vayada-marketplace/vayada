-- VAY-1092: native setup logins may lock their authorization rows, not edit
-- them. No runtime grant, login, readiness transition, or activation here.
CREATE FUNCTION platform.hotel_setup_property_assigned_organization()
RETURNS UUID LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE assignment RECORD;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE')
  THEN RETURN NULL; END IF;
  SELECT scope.property_id, scope.organization_id INTO assignment
  FROM platform.hotel_setup_property_scopes scope
  WHERE scope.database_login = session_user AND scope.active;
  IF NOT FOUND OR NOT platform.hotel_setup_property_allowed(
    assignment.property_id, assignment.organization_id
  ) THEN RETURN NULL; END IF;
  RETURN assignment.organization_id;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_assigned_organization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_assigned_organization()
  TO vayada_next_hotel_setup_property_scope;

-- The command also reads the current base PMS entitlement, including a global
-- suspension in its assigned organization. Financials stays property-scoped.
CREATE OR REPLACE FUNCTION platform.hotel_setup_property_financials_read_allowed(
  requested_organization_id UUID, product TEXT, entitlement_key TEXT,
  resource_product TEXT, resource_type TEXT, resource_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> session_user OR NOT pg_catalog.pg_has_role(
    session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'
  ) OR product <> 'pms' OR entitlement_key NOT IN (
    'module:financials', 'property-management', 'pms-core', 'account_access'
  ) THEN RETURN FALSE; END IF;
  IF entitlement_key <> 'module:financials' AND resource_product IS NULL
    AND resource_type IS NULL AND resource_id IS NULL
  THEN RETURN requested_organization_id = platform.hotel_setup_property_assigned_organization(); END IF;
  IF resource_product IS DISTINCT FROM 'pms' OR resource_type IS DISTINCT FROM 'pms_property'
    OR resource_id IS NULL OR NOT pg_catalog.pg_input_is_valid(resource_id, 'uuid')
  THEN RETURN FALSE; END IF;
  RETURN platform.hotel_setup_property_row_allowed(resource_id::uuid, requested_organization_id);
END $$;

-- USING provides UPDATE-policy visibility for FOR SHARE / FOR KEY SHARE.
-- WITH CHECK denies actual UPDATE, including no-op and ON CONFLICT updates.
DROP POLICY hotel_setup_property_catalog_update_denial ON hotel_catalog.properties;
DROP POLICY hotel_setup_property_owner_link_update_denial ON identity.organization_resource_links;
DROP POLICY hotel_setup_property_entitlement_update_denial ON identity.product_entitlements;
DO $$
DECLARE item RECORD;
DECLARE non_setup TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_property_'
  AND current_user::text !~ '^vayada_next_hotel_setup_property_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
$guard$;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('identity.organizations'::regclass,
      'id = platform.hotel_setup_property_assigned_organization()', true),
    ('identity.users'::regclass,
      'EXISTS (SELECT 1 FROM identity.organization_memberships m
        WHERE m.user_id = users.id AND m.organization_id = platform.hotel_setup_property_assigned_organization())', true),
    ('identity.organization_memberships'::regclass,
      'organization_id = platform.hotel_setup_property_assigned_organization()', true),
    ('identity.role_permission_grants'::regclass,
      'organization_kind = ''hotel_group'' AND EXISTS (
        SELECT 1 FROM identity.organization_memberships m
        WHERE m.role_key = role_permission_grants.role_key
          AND m.organization_id = platform.hotel_setup_property_assigned_organization())', true),
    ('hotel_catalog.properties'::regclass,
      'platform.hotel_setup_property_row_allowed(id)', false),
    ('identity.organization_resource_links'::regclass,
      'status = ''active'' AND relationship = ''owner''
        AND platform.hotel_setup_property_owner_link_allowed(organization_id, product, resource_type, resource_id)', false),
    ('identity.product_entitlements'::regclass,
      'platform.hotel_setup_property_financials_read_allowed(organization_id, product, entitlement_key, resource_product, resource_type, resource_id)', false)
  ) AS scope(relation, predicate, new_scope) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = item.relation)
    THEN RAISE EXCEPTION 'setup lock relation lacks RLS: %', item.relation; END IF;
    IF item.new_scope THEN
      EXECUTE format('CREATE POLICY hotel_setup_property_identity_guard ON %s
        AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
          AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_property_scope'', ''USAGE'')))',
        item.relation, non_setup);
      EXECUTE format('CREATE POLICY hotel_setup_property_identity_read ON %s
        AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_property_scope USING (%s)',
        item.relation, item.predicate);
      EXECUTE format('CREATE POLICY hotel_setup_property_identity_insert_denial ON %s
        AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (%s)', item.relation, non_setup);
      EXECUTE format('CREATE POLICY hotel_setup_property_identity_delete_denial ON %s
        AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', item.relation, non_setup);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_update_scope ON %s
      AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_property_scope
      USING (%s) WITH CHECK (false)', item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (%s)', item.relation, non_setup);
  END LOOP;
END $$;
