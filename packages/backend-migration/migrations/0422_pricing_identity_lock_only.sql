-- VAY-1543: pricing logins may lock live identity authorization rows, not edit them.
-- Grants for the separately isolated service are a later platform change.
-- The existing finance-worker policies already provide permissive visibility
-- for these two tables; retain their restrictive scope checks.
CREATE POLICY pricing_runtime_link_lock_only ON identity.organization_resource_links
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
CREATE POLICY pricing_runtime_entitlement_lock_only ON identity.product_entitlements
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

-- These three tables did not use RLS. Preserve existing ACL-backed behavior
-- for non-pricing roles while making row-lock UPDATE grants safe for pricing.
ALTER TABLE identity.organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_runtime_existing_access ON identity.organization_memberships
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_runtime_membership_lock_only ON identity.organization_memberships
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

ALTER TABLE identity.membership_property_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_runtime_existing_access ON identity.membership_property_assignments
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_runtime_assignment_lock_only ON identity.membership_property_assignments
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

ALTER TABLE identity.role_permission_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_runtime_existing_access ON identity.role_permission_grants
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_runtime_permission_lock_only ON identity.role_permission_grants
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
