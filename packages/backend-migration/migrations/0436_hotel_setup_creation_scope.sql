-- VAY-1092: bind a new property to the organization of its setup login.
-- The non-login scope role is granted only the view needed by setup logins.
-- No runtime login or base-table write privilege is created or granted here.
ALTER TABLE hotel_catalog.properties
  ADD COLUMN creation_organization_id UUID REFERENCES identity.organizations(id);

CREATE TABLE platform.hotel_setup_creation_scopes (
  database_login NAME PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hotel_setup_creation_login_name CHECK (
    database_login::text ~ '^vayada_next_hotel_setup_org_[a-z0-9_]+$'
  )
);
REVOKE ALL ON platform.hotel_setup_creation_scopes FROM PUBLIC;

CREATE TABLE platform.hotel_setup_linked_properties (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE
);
REVOKE ALL ON platform.hotel_setup_linked_properties FROM PUBLIC;

CREATE FUNCTION platform.record_hotel_setup_owner_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO platform.hotel_setup_linked_properties (property_id)
  SELECT property.id FROM hotel_catalog.properties property
  WHERE property.id::text = NEW.resource_id
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.record_hotel_setup_owner_link() FROM PUBLIC;
CREATE TRIGGER record_hotel_setup_owner_link
AFTER INSERT OR UPDATE ON identity.organization_resource_links
FOR EACH ROW WHEN (
  NEW.product = 'hotel_catalog' AND NEW.resource_type = 'property'
  AND NEW.relationship = 'owner'
)
EXECUTE FUNCTION platform.record_hotel_setup_owner_link();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'vayada_next_hotel_setup_scope') THEN
    CREATE ROLE vayada_next_hotel_setup_scope NOLOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'vayada_next_hotel_setup_scope'
      AND NOT (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
        OR rolinherit OR rolbypassrls OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'hotel setup scope role is unsafe';
  END IF;
END $$;

CREATE VIEW hotel_catalog.hotel_setup_effective_creation_scopes
WITH (security_barrier = true) AS
SELECT scope.organization_id
FROM platform.hotel_setup_creation_scopes scope
JOIN identity.organizations organization ON organization.id = scope.organization_id
WHERE scope.database_login = session_user
  AND current_user = session_user
  AND organization.kind = 'hotel_group'
  AND organization.status = 'active';
REVOKE ALL ON hotel_catalog.hotel_setup_effective_creation_scopes FROM PUBLIC;

-- This helper reads owner links without granting them to the setup login.
-- The PUBLIC guard below separately rejects SET ROLE before the policy calls it.
CREATE FUNCTION platform.hotel_setup_property_read_allowed(
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
            AND link.resource_id = $1::text
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
          AND NOT EXISTS (
            SELECT 1 FROM identity.organization_resource_links link
            WHERE link.product = 'hotel_catalog'
              AND link.resource_type = 'property'
              AND link.resource_id = $1::text
              AND link.relationship = 'owner'
          )
        )
      )
  );
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_read_allowed(UUID, UUID) FROM PUBLIC;
CREATE FUNCTION platform.hotel_setup_property_id_unlinked(property_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM identity.organization_resource_links link
    WHERE link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.resource_id = $1::text
      AND link.relationship = 'owner'
  );
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_id_unlinked(UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA hotel_catalog TO vayada_next_hotel_setup_scope;
GRANT SELECT ON hotel_catalog.hotel_setup_effective_creation_scopes
  TO vayada_next_hotel_setup_scope;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_read_allowed(UUID, UUID)
  TO vayada_next_hotel_setup_scope;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_property_id_unlinked(UUID)
  TO vayada_next_hotel_setup_scope;

-- Existing roles need no view privilege. A setup-prefixed login without the
-- scope membership fails closed even if it has base-table permissions.
CREATE POLICY hotel_setup_creation_insert_guard ON hotel_catalog.properties
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_creation_read_guard ON hotel_catalog.properties
  AS RESTRICTIVE FOR SELECT TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER'))
    OR (current_user = session_user
      AND pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'USAGE'))
  );
CREATE POLICY hotel_setup_creation_insert_scope ON hotel_catalog.properties
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (
    EXISTS (SELECT 1 FROM hotel_catalog.hotel_setup_effective_creation_scopes scope
            WHERE scope.organization_id = properties.creation_organization_id)
    AND platform.hotel_setup_property_id_unlinked(id)
  );
CREATE POLICY hotel_setup_creation_read_scope ON hotel_catalog.properties
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (
    platform.hotel_setup_property_read_allowed(id, creation_organization_id)
  );

CREATE POLICY hotel_setup_creation_update_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );

CREATE POLICY hotel_setup_creation_delete_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  );
