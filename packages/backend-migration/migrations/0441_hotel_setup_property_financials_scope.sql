-- VAY-1092: stage one hotel's currency, starter categories, and Financials read
-- scope. Provisioning, grants, secrets, and auto-activation are separate gates.
CREATE TABLE platform.hotel_setup_property_scopes (
  database_login NAME PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hotel_setup_property_login_name CHECK (
    database_login::text ~ '^vayada_next_hotel_setup_property_[a-z0-9_]+$'
  )
);
CREATE UNIQUE INDEX hotel_setup_one_active_login_per_property
  ON platform.hotel_setup_property_scopes (property_id) WHERE active;
REVOKE ALL ON platform.hotel_setup_property_scopes FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'vayada_next_hotel_setup_property_scope'
  ) THEN
    CREATE ROLE vayada_next_hotel_setup_property_scope NOLOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'vayada_next_hotel_setup_property_scope'
      AND NOT (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
        OR rolinherit OR rolbypassrls OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'hotel setup property scope role is unsafe';
  END IF;
END $$;

-- Lock the assignment before reading current owner links. Owner transfer must
-- replace both links and the assignment in one transaction.
CREATE FUNCTION platform.hotel_setup_property_allowed(
  requested_property_id UUID, requested_organization_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assignment RECORD;
BEGIN
  SELECT scope.property_id, scope.organization_id INTO assignment
  FROM platform.hotel_setup_property_scopes scope
  JOIN identity.organizations organization ON organization.id = scope.organization_id
  WHERE scope.database_login = session_user AND scope.active
    AND scope.property_id = requested_property_id
    AND (requested_organization_id IS NULL
      OR scope.organization_id = requested_organization_id)
    AND organization.kind = 'hotel_group' AND organization.status = 'active'
  FOR SHARE OF scope, organization;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  RETURN EXISTS (
    SELECT 1
    FROM identity.organization_resource_links catalog_link
    JOIN identity.organization_resource_links pms_link
      ON pms_link.organization_id = catalog_link.organization_id
      AND pms_link.product = 'pms' AND pms_link.resource_type = 'pms_property'
      AND platform.hotel_setup_property_link_matches(
        requested_property_id, pms_link.resource_id
      )
      AND pms_link.relationship = 'owner' AND pms_link.status = 'active'
    WHERE catalog_link.organization_id = assignment.organization_id
      AND catalog_link.product = 'hotel_catalog'
      AND catalog_link.resource_type = 'property'
      AND platform.hotel_setup_property_link_matches(
        requested_property_id, catalog_link.resource_id
      )
      AND catalog_link.relationship = 'owner' AND catalog_link.status = 'active'
    FOR SHARE OF catalog_link, pms_link
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_allowed(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_allowed(UUID, UUID)
  TO vayada_next_hotel_setup_property_scope;

CREATE FUNCTION platform.hotel_setup_property_row_allowed(
  requested_property_id UUID, requested_organization_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> session_user OR NOT pg_catalog.pg_has_role(
    session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'
  ) THEN RETURN FALSE; END IF;
  RETURN platform.hotel_setup_property_allowed(
    requested_property_id, requested_organization_id
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_row_allowed(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_row_allowed(UUID, UUID)
  TO vayada_next_hotel_setup_property_scope;

CREATE FUNCTION platform.hotel_setup_property_owner_link_allowed(
  requested_organization_id UUID, product TEXT, resource_type TEXT, resource_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
BEGIN
  IF NOT ((product = 'hotel_catalog' AND resource_type = 'property')
    OR (product = 'pms' AND resource_type = 'pms_property'))
    OR NOT pg_catalog.pg_input_is_valid(resource_id, 'uuid')
  THEN RETURN FALSE; END IF;
  RETURN platform.hotel_setup_property_row_allowed(
    resource_id::uuid, requested_organization_id
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_owner_link_allowed(
  UUID, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_owner_link_allowed(
  UUID, TEXT, TEXT, TEXT
) TO vayada_next_hotel_setup_property_scope;

CREATE FUNCTION platform.hotel_setup_property_financials_read_allowed(
  requested_organization_id UUID, product TEXT, entitlement_key TEXT,
  resource_product TEXT, resource_type TEXT, resource_id TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
BEGIN
  IF product <> 'pms' OR entitlement_key <> 'module:financials'
    OR resource_product <> 'pms' OR resource_type <> 'pms_property'
    OR NOT pg_catalog.pg_input_is_valid(resource_id, 'uuid')
  THEN RETURN FALSE; END IF;
  RETURN platform.hotel_setup_property_row_allowed(
    resource_id::uuid, requested_organization_id
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_financials_read_allowed(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_financials_read_allowed(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO vayada_next_hotel_setup_property_scope;

-- The public guard leaves all existing logins alone. A property-prefixed login
-- without the non-settable scope membership fails closed; SET ROLE also fails.
CREATE POLICY hotel_setup_property_currency_guard ON pms.property_pricing_settings
  AS RESTRICTIVE TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_property_'
      AND current_user::text !~ '^vayada_next_hotel_setup_property_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_property_currency_scope ON pms.property_pricing_settings
  AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
  USING (platform.hotel_setup_property_row_allowed(property_id))
  WITH CHECK (platform.hotel_setup_property_row_allowed(property_id));
CREATE POLICY hotel_setup_property_currency_delete_denial ON pms.property_pricing_settings
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );

CREATE POLICY hotel_setup_property_category_guard ON finance.expense_categories
  AS RESTRICTIVE TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_property_'
      AND current_user::text !~ '^vayada_next_hotel_setup_property_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_property_category_scope ON finance.expense_categories
  AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
  USING (platform.hotel_setup_property_row_allowed(property_id))
  WITH CHECK (platform.hotel_setup_property_row_allowed(property_id));
CREATE POLICY hotel_setup_property_category_update_denial ON finance.expense_categories
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );
CREATE POLICY hotel_setup_property_category_delete_denial ON finance.expense_categories
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );

CREATE POLICY hotel_setup_property_entitlement_guard ON identity.product_entitlements
  AS RESTRICTIVE TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_property_'
      AND current_user::text !~ '^vayada_next_hotel_setup_property_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_property_entitlement_read_scope ON identity.product_entitlements
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_property_scope USING (
    platform.hotel_setup_property_financials_read_allowed(
      organization_id, product, entitlement_key,
      resource_product, resource_type, resource_id
    )
  );
CREATE POLICY hotel_setup_property_entitlement_insert_denial ON identity.product_entitlements
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );
CREATE POLICY hotel_setup_property_entitlement_update_denial ON identity.product_entitlements
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );
CREATE POLICY hotel_setup_property_entitlement_delete_denial ON identity.product_entitlements
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_property_'
    AND current_user::text !~ '^vayada_next_hotel_setup_property_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  );

CREATE POLICY hotel_setup_property_catalog_guard ON hotel_catalog.properties
  AS RESTRICTIVE TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_property_'
      AND current_user::text !~ '^vayada_next_hotel_setup_property_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_property_catalog_read_scope ON hotel_catalog.properties
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_property_scope
  USING (platform.hotel_setup_property_row_allowed(id));
CREATE POLICY hotel_setup_property_catalog_insert_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_property_scope
  WITH CHECK (FALSE);
CREATE POLICY hotel_setup_property_catalog_update_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_property_scope
  USING (FALSE) WITH CHECK (FALSE);
CREATE POLICY hotel_setup_property_catalog_delete_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR DELETE TO vayada_next_hotel_setup_property_scope
  USING (FALSE);

CREATE POLICY hotel_setup_property_owner_link_guard ON identity.organization_resource_links
  AS RESTRICTIVE TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_property_'
      AND current_user::text !~ '^vayada_next_hotel_setup_property_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_property_owner_link_read_scope ON identity.organization_resource_links
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_property_scope USING (
    status = 'active' AND relationship = 'owner'
    AND platform.hotel_setup_property_owner_link_allowed(
      organization_id, product, resource_type, resource_id
    )
  );
CREATE POLICY hotel_setup_property_owner_link_insert_denial ON identity.organization_resource_links
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_property_scope
  WITH CHECK (FALSE);
CREATE POLICY hotel_setup_property_owner_link_update_denial ON identity.organization_resource_links
  AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_property_scope
  USING (FALSE) WITH CHECK (FALSE);
CREATE POLICY hotel_setup_property_owner_link_delete_denial ON identity.organization_resource_links
  AS RESTRICTIVE FOR DELETE TO vayada_next_hotel_setup_property_scope
  USING (FALSE);
