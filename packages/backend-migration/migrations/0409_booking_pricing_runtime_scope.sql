-- VAY-1543: database-owned scope for separately provisioned pricing logins.
-- Existing roles retain their behavior. Platform provisioning and grants are
-- separate reviewed steps; a pricing-prefixed login without an assignment is denied.
CREATE TABLE platform.pricing_runtime_property_scopes (
  database_login NAME PRIMARY KEY,
  operation_class TEXT NOT NULL CHECK (operation_class IN ('owner_read','owner_manage','public')),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (database_login::text ~ '^vayada_next_pricing_[a-z0-9_]+$')
);
REVOKE ALL ON platform.pricing_runtime_property_scopes FROM PUBLIC;

-- Security-barrier views expose only the authenticated login's assignment.
-- Their owner reads the private scope table; callers receive no table access
-- and no SECURITY DEFINER routine can conflict with cutover attestation.
CREATE VIEW booking.pricing_runtime_effective_property_scopes
WITH (security_barrier = true)
AS
SELECT scope.operation_class, scope.property_id, scope.organization_id
FROM platform.pricing_runtime_property_scopes scope
WHERE scope.database_login = session_user
  AND current_user = session_user;
REVOKE ALL ON booking.pricing_runtime_effective_property_scopes FROM PUBLIC;
GRANT SELECT ON booking.pricing_runtime_effective_property_scopes TO PUBLIC;

CREATE VIEW booking.pricing_runtime_effective_authority_scopes
WITH (security_barrier = true)
AS
SELECT scope.operation_class, revision.property_id, revision.revision
FROM platform.pricing_runtime_property_scopes scope
JOIN booking.pricing_authority_revisions revision
  ON revision.property_id = scope.property_id
 AND revision.organization_id = scope.organization_id
WHERE scope.database_login = session_user
  AND current_user = session_user;
REVOKE ALL ON booking.pricing_runtime_effective_authority_scopes FROM PUBLIC;
GRANT SELECT ON booking.pricing_runtime_effective_authority_scopes TO PUBLIC;

ALTER TABLE booking.pricing_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_quotes_existing_access ON booking.pricing_quotes
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_quotes_runtime_insert_scope ON booking.pricing_quotes
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_pricing_'
      AND current_user::text !~ '^vayada_next_pricing_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles pricing_role
        WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
          AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM booking.pricing_runtime_effective_property_scopes scope
      WHERE scope.operation_class = 'public'
        AND scope.property_id = pricing_quotes.property_id
        AND scope.organization_id = pricing_quotes.organization_id
    )
  );
CREATE POLICY pricing_quotes_runtime_delete_denial ON booking.pricing_quotes
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

ALTER TABLE booking.pricing_authority_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_authority_revisions_existing_access ON booking.pricing_authority_revisions
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_authority_revisions_runtime_insert_scope
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_pricing_'
      AND current_user::text !~ '^vayada_next_pricing_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles pricing_role
        WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
          AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM booking.pricing_runtime_effective_property_scopes scope
      WHERE scope.operation_class = 'owner_manage'
        AND scope.property_id = pricing_authority_revisions.property_id
        AND scope.organization_id = pricing_authority_revisions.organization_id
    )
  );
CREATE POLICY pricing_authority_revisions_runtime_update_denial
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
CREATE POLICY pricing_authority_revisions_runtime_delete_denial
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

ALTER TABLE booking.pricing_authority_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_authority_heads_existing_access ON booking.pricing_authority_heads
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_authority_heads_runtime_insert_scope ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    (session_user::text !~ '^vayada_next_pricing_'
      AND current_user::text !~ '^vayada_next_pricing_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles pricing_role
        WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
          AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM booking.pricing_runtime_effective_authority_scopes scope
      WHERE scope.operation_class = 'owner_manage'
        AND scope.property_id = pricing_authority_heads.property_id
        AND scope.revision = pricing_authority_heads.revision
    )
  );
CREATE POLICY pricing_authority_heads_runtime_update_scope ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    (session_user::text !~ '^vayada_next_pricing_'
      AND current_user::text !~ '^vayada_next_pricing_'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles pricing_role
        WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
          AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
      ))
    OR EXISTS (
      SELECT 1 FROM booking.pricing_runtime_effective_authority_scopes scope
      WHERE scope.operation_class = 'owner_manage'
        AND scope.property_id = pricing_authority_heads.property_id
        AND scope.revision = pricing_authority_heads.revision
    )
  );
CREATE POLICY pricing_authority_heads_runtime_delete_denial ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
