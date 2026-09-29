-- VAY-1092: an organization setup login may link only its newly created property.
-- Runtime credentials and table grants are provisioned separately.
-- Historic owner links use TEXT IDs and may spell the same UUID differently.
CREATE FUNCTION platform.hotel_setup_property_link_matches(
  property_id UUID, resource_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_catalog.pg_input_is_valid(resource_id, 'uuid') THEN
    RETURN FALSE;
  END IF;
  RETURN property_id = resource_id::uuid;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_link_matches(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_link_matches(UUID, TEXT)
  TO vayada_next_hotel_setup_scope;

CREATE OR REPLACE FUNCTION platform.record_hotel_setup_owner_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_catalog.pg_input_is_valid(NEW.resource_id, 'uuid') THEN
    RETURN NEW;
  END IF;
  INSERT INTO platform.hotel_setup_linked_properties (property_id)
  SELECT property.id FROM hotel_catalog.properties property
  WHERE property.id = NEW.resource_id::uuid
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

INSERT INTO platform.hotel_setup_linked_properties (property_id)
SELECT DISTINCT property.id
FROM identity.organization_resource_links link
JOIN hotel_catalog.properties property
  ON property.id = CASE
    WHEN pg_catalog.pg_input_is_valid(link.resource_id, 'uuid')
    THEN link.resource_id::uuid
  END
WHERE link.product = 'hotel_catalog'
  AND link.resource_type = 'property'
  AND link.relationship = 'owner'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION platform.hotel_setup_property_id_unlinked(property_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM identity.organization_resource_links link
    WHERE link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.relationship = 'owner'
      AND platform.hotel_setup_property_link_matches($1, link.resource_id)
  );
$$;

CREATE OR REPLACE FUNCTION platform.hotel_setup_property_read_allowed(
  property_id UUID, creation_organization_id UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform.hotel_setup_creation_scopes scope
    JOIN identity.organizations organization ON organization.id = scope.organization_id
    WHERE scope.database_login = session_user
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
      AND (
        EXISTS (
          SELECT 1 FROM identity.organization_resource_links link
          WHERE link.product = 'hotel_catalog'
            AND link.resource_type = 'property'
            AND platform.hotel_setup_property_link_matches($1, link.resource_id)
            AND link.relationship = 'owner'
            AND link.status = 'active'
            AND link.organization_id = scope.organization_id
        )
        OR (
          $2 = scope.organization_id
          AND NOT EXISTS (
            SELECT 1 FROM platform.hotel_setup_linked_properties linked
            WHERE linked.property_id = $1
          )
          AND platform.hotel_setup_property_id_unlinked($1)
        )
      )
  );
$$;

CREATE FUNCTION platform.hotel_setup_owner_link_insert_allowed(
  organization_id UUID, resource_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
    FROM platform.hotel_setup_creation_scopes scope
    JOIN identity.organizations organization ON organization.id = scope.organization_id
    JOIN hotel_catalog.properties property ON property.id::text = $2
    WHERE scope.database_login = session_user
      AND scope.organization_id = $1
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
      AND property.creation_organization_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM platform.hotel_setup_linked_properties linked
        WHERE linked.property_id = property.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM identity.organization_resource_links link
        WHERE link.product = 'hotel_catalog'
          AND link.resource_type = 'property'
          AND platform.hotel_setup_property_link_matches(property.id, link.resource_id)
          AND link.relationship = 'owner'
      )
  );
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_owner_link_insert_allowed(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_owner_link_insert_allowed(UUID, TEXT)
  TO vayada_next_hotel_setup_scope;

CREATE POLICY hotel_setup_link_read_guard ON identity.organization_resource_links
  AS RESTRICTIVE FOR SELECT TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_owner_link_read_scope ON identity.organization_resource_links
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (
    product = 'hotel_catalog' AND resource_type = 'property'
    AND relationship = 'owner' AND status = 'active'
    AND EXISTS (
      SELECT 1 FROM hotel_catalog.hotel_setup_effective_creation_scopes scope
      WHERE scope.organization_id = organization_resource_links.organization_id
    )
    AND EXISTS (
      SELECT 1 FROM hotel_catalog.properties property
      WHERE platform.hotel_setup_property_link_matches(
        property.id, organization_resource_links.resource_id
      )
        AND platform.hotel_setup_property_read_allowed(
          property.id, property.creation_organization_id
        )
    )
  );

CREATE POLICY hotel_setup_link_insert_guard ON identity.organization_resource_links
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_owner_link_insert_scope ON identity.organization_resource_links
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (
    product = 'hotel_catalog' AND resource_type = 'property'
    AND relationship = 'owner' AND status = 'active'
    AND platform.hotel_setup_owner_link_insert_allowed(organization_id, resource_id)
  );

CREATE POLICY hotel_setup_link_update_denial ON identity.organization_resource_links
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  ) WITH CHECK (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );
CREATE POLICY hotel_setup_link_delete_denial ON identity.organization_resource_links
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );
