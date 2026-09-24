-- VAY-1543: pricing logins may lock authorization rows, not edit them.
-- Existing ACLs and non-pricing RLS behavior remain unchanged. The dedicated
-- pricing grants and the rest of the lock-only relation matrix are separate.
CREATE POLICY pricing_runtime_organization_lock_only ON identity.organizations
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

-- Users had no RLS before this migration; preserve every existing ACL-backed
-- read/write path while adding the pricing-only restrictive check.
ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_runtime_existing_access ON identity.users
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_runtime_user_lock_only ON identity.users
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

-- The Finance worker already enabled RLS here; compose with its policies.
CREATE POLICY pricing_runtime_property_lock_only ON hotel_catalog.properties
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
