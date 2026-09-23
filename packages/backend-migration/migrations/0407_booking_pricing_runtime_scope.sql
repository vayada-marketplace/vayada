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

-- RLS callers must not need direct access to the assignment table. These
-- predicates expose only a decision for the authenticated session and use a
-- fixed search path; PUBLIC execute preserves policies for existing writers.
CREATE FUNCTION platform.pricing_runtime_legacy_access_allowed(
  caller_current_user NAME
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT session_user::text !~ '^vayada_next_pricing_'
    AND caller_current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1
      FROM platform.pricing_runtime_property_scopes assigned
      JOIN pg_catalog.pg_roles assigned_role
        ON assigned_role.rolname = assigned.database_login::text
      WHERE pg_catalog.pg_has_role(session_user, assigned_role.oid, 'member')
    )
$$;

CREATE FUNCTION platform.pricing_runtime_write_scope_allows(
  caller_current_user NAME,
  required_operation TEXT,
  checked_property_id UUID,
  checked_organization_id UUID,
  checked_revision UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT caller_current_user = session_user
    AND EXISTS (
      SELECT 1
      FROM platform.pricing_runtime_property_scopes scope
      WHERE scope.database_login = session_user
        AND scope.operation_class = required_operation
        AND scope.property_id = checked_property_id
        AND (
          (checked_revision IS NULL
            AND scope.organization_id = checked_organization_id)
          OR (checked_organization_id IS NULL
            AND checked_revision IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM booking.pricing_authority_revisions revision
              WHERE revision.property_id = checked_property_id
                AND revision.revision = checked_revision
                AND revision.organization_id = scope.organization_id
            ))
        )
    )
$$;

REVOKE ALL ON FUNCTION platform.pricing_runtime_legacy_access_allowed(NAME) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.pricing_runtime_write_scope_allows(NAME,TEXT,UUID,UUID,UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.pricing_runtime_legacy_access_allowed(NAME) TO PUBLIC;
GRANT EXECUTE ON FUNCTION platform.pricing_runtime_write_scope_allows(NAME,TEXT,UUID,UUID,UUID)
  TO PUBLIC;

ALTER TABLE booking.pricing_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_quotes_existing_access ON booking.pricing_quotes
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_quotes_runtime_insert_scope ON booking.pricing_quotes
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    platform.pricing_runtime_legacy_access_allowed(current_user)
    OR platform.pricing_runtime_write_scope_allows(
      current_user,
      'public',
      pricing_quotes.property_id,
      pricing_quotes.organization_id,
      NULL
    )
  );
CREATE POLICY pricing_quotes_runtime_delete_denial ON booking.pricing_quotes
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    platform.pricing_runtime_legacy_access_allowed(current_user)
  );

ALTER TABLE booking.pricing_authority_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_authority_revisions_existing_access ON booking.pricing_authority_revisions
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_authority_revisions_runtime_insert_scope
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    platform.pricing_runtime_legacy_access_allowed(current_user)
    OR platform.pricing_runtime_write_scope_allows(
      current_user,
      'owner_manage',
      pricing_authority_revisions.property_id,
      pricing_authority_revisions.organization_id,
      NULL
    )
  );
CREATE POLICY pricing_authority_revisions_runtime_update_denial
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    platform.pricing_runtime_legacy_access_allowed(current_user)
  );
CREATE POLICY pricing_authority_revisions_runtime_delete_denial
  ON booking.pricing_authority_revisions
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    platform.pricing_runtime_legacy_access_allowed(current_user)
  );

ALTER TABLE booking.pricing_authority_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_authority_heads_existing_access ON booking.pricing_authority_heads
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_authority_heads_runtime_insert_scope ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (
    platform.pricing_runtime_legacy_access_allowed(current_user)
    OR platform.pricing_runtime_write_scope_allows(
      current_user,
      'owner_manage',
      pricing_authority_heads.property_id,
      NULL,
      pricing_authority_heads.revision
    )
  );
CREATE POLICY pricing_authority_heads_runtime_update_scope ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    platform.pricing_runtime_legacy_access_allowed(current_user)
    OR platform.pricing_runtime_write_scope_allows(
      current_user,
      'owner_manage',
      pricing_authority_heads.property_id,
      NULL,
      pricing_authority_heads.revision
    )
  );
CREATE POLICY pricing_authority_heads_runtime_delete_denial ON booking.pricing_authority_heads
  AS RESTRICTIVE FOR DELETE TO PUBLIC USING (
    platform.pricing_runtime_legacy_access_allowed(current_user)
  );
