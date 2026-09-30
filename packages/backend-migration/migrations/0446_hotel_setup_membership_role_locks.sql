-- VAY-1092: current saved roles and property assignments are lock-only for
-- native setup credentials. No login, grant or Financials activation.
DO $$
DECLARE item RECORD;
DECLARE non_setup TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_property_'
  AND current_user::text !~ '^vayada_next_hotel_setup_property_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
$guard$;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('identity.organization_roles'::regclass,
      'organization_id = platform.hotel_setup_property_assigned_organization()'),
    ('identity.membership_property_assignments'::regclass,
      'platform.hotel_setup_property_row_allowed(property_id) AND EXISTS (
        SELECT 1 FROM identity.organization_memberships m
        WHERE m.id = membership_property_assignments.membership_id
          AND m.organization_id = platform.hotel_setup_property_assigned_organization())')
  ) AS scope(relation, predicate) LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = item.relation) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.relation);
      EXECUTE format('CREATE POLICY hotel_setup_property_existing_access ON %s
        TO PUBLIC USING (true) WITH CHECK (true)', item.relation);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_property_scope'', ''USAGE'')))',
      item.relation, non_setup);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_read ON %s
      AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_property_scope USING (%s)',
      item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_insert_denial ON %s
      AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (%s)', item.relation, non_setup);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_delete_denial ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', item.relation, non_setup);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_update_scope ON %s
      AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_property_scope
      USING (%s) WITH CHECK (false)', item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_property_identity_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (%s)', item.relation, non_setup);
  END LOOP;
END $$;
