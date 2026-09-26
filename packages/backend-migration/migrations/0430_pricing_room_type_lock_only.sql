-- VAY-1543: pricing logins may lock room types for current-source reads,
-- but must not edit PMS inventory. Grants remain a separate platform change.
-- Compose with the existing Channex scope and compatibility policies.
CREATE POLICY pricing_runtime_room_type_lock_only ON pms.room_types
  AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
    session_user::text !~ '^vayada_next_pricing_'
    AND current_user::text !~ '^vayada_next_pricing_'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles pricing_role
      WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
        AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
    )
  );
