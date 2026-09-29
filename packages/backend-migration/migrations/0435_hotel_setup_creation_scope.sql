-- VAY-1092: bind a new property to the organization of its setup login.
-- No runtime login or privilege is created or granted by this migration.
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
GRANT SELECT ON hotel_catalog.hotel_setup_effective_creation_scopes TO PUBLIC;

-- Properties already have RLS. Preserve non-setup roles, including Finance and
-- pricing policies, while restricting any setup-prefixed or member login.
CREATE POLICY hotel_setup_creation_insert_scope ON hotel_catalog.properties
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles setup_role
        WHERE setup_role.rolname ~ '^vayada_next_hotel_setup_org_'
          AND pg_catalog.pg_has_role(session_user, setup_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM hotel_catalog.hotel_setup_effective_creation_scopes scope
      WHERE scope.organization_id = properties.creation_organization_id
    )
  );

CREATE POLICY hotel_setup_creation_read_scope ON hotel_catalog.properties
  AS RESTRICTIVE FOR SELECT TO PUBLIC USING (
    (session_user::text !~ '^vayada_next_hotel_setup_org_'
      AND current_user::text !~ '^vayada_next_hotel_setup_org_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles setup_role
        WHERE setup_role.rolname ~ '^vayada_next_hotel_setup_org_'
          AND pg_catalog.pg_has_role(session_user, setup_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM hotel_catalog.hotel_setup_effective_creation_scopes scope
      WHERE scope.organization_id = properties.creation_organization_id
    )
  );

CREATE POLICY hotel_setup_creation_update_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles setup_role
      WHERE setup_role.rolname ~ '^vayada_next_hotel_setup_org_'
        AND pg_catalog.pg_has_role(session_user, setup_role.oid, 'member')
    )
  );

CREATE POLICY hotel_setup_creation_delete_denial ON hotel_catalog.properties
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND current_user::text !~ '^vayada_next_hotel_setup_org_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles setup_role
      WHERE setup_role.rolname ~ '^vayada_next_hotel_setup_org_'
        AND pg_catalog.pg_has_role(session_user, setup_role.oid, 'member')
    )
  );
