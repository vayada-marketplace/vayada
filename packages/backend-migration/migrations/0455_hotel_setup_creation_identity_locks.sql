-- VAY-965: current identity reads and row locks for creation credentials.
-- Key-column UPDATE grants can take row locks, but RLS rejects actual changes.
DO $$
DECLARE item RECORD; was_scoped BOOLEAN;
DECLARE non_creation TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_org_'
  AND current_user::text !~ '^vayada_next_hotel_setup_org_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
$guard$;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('identity.organizations'::regclass,
      'id = platform.hotel_setup_creation_assigned_organization()'),
    ('identity.organization_memberships'::regclass,
      'organization_id = platform.hotel_setup_creation_assigned_organization()'),
    ('identity.users'::regclass,
      'EXISTS (SELECT 1 FROM identity.organization_memberships m
        WHERE m.user_id = users.id
          AND m.organization_id = platform.hotel_setup_creation_assigned_organization())'),
    ('identity.organization_roles'::regclass,
      'organization_id = platform.hotel_setup_creation_assigned_organization()'),
    ('identity.role_permission_grants'::regclass,
      'organization_kind = ''hotel_group'' AND EXISTS (
        SELECT 1 FROM identity.organization_memberships m
        WHERE m.role_key = role_permission_grants.role_key
          AND m.organization_id = platform.hotel_setup_creation_assigned_organization())')
  ) AS scope(relation, predicate) LOOP
    SELECT relrowsecurity INTO was_scoped FROM pg_catalog.pg_class WHERE oid = item.relation;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.relation);
    IF NOT was_scoped THEN
      EXECUTE format('CREATE POLICY hotel_setup_creation_identity_compat ON %s
        TO PUBLIC USING (%s) WITH CHECK (%s)', item.relation, non_creation, non_creation);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_permit ON %s
      TO vayada_next_hotel_setup_scope USING (true) WITH CHECK (true)', item.relation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))
      WITH CHECK ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))',
      item.relation, non_creation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_read ON %s
      AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (%s)',
      item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_update_scope ON %s
      AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_scope USING (%s) WITH CHECK (false)',
      item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (%s)', item.relation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_insert_denial ON %s
      AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (%s)', item.relation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_identity_delete_denial ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', item.relation, non_creation);
  END LOOP;
END $$;
