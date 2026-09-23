-- VAY-1543: pricing logins may lock organizations for authorization, not edit them.
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
