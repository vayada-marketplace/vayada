-- VAY-1543: pricing logins may lock public discovery rows, not edit them.
-- Existing affiliate, Finance, and Channex policies remain in force.
CREATE POLICY pricing_runtime_slug_lock_only ON hotel_catalog.property_slugs
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

CREATE POLICY pricing_runtime_location_lock_only ON hotel_catalog.property_locations
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );

-- This profile previously had no RLS. Preserve ACL-backed behavior for other
-- roles while making the pricing lock grant safe.
ALTER TABLE distribution.public_hotel_bookability_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_runtime_existing_access ON distribution.public_hotel_bookability_profiles
  TO PUBLIC USING (true) WITH CHECK (true);
CREATE POLICY pricing_runtime_profile_lock_only ON distribution.public_hotel_bookability_profiles
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
