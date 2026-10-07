-- VAY-2054: the ordinary API login may lock identity authorization rows, not edit them.
-- The API takes FOR SHARE / FOR KEY SHARE / FOR UPDATE locks on these six tables
-- (shared scope-lock clause, onboarding drafts, pricing authorization). PostgreSQL
-- needs an UPDATE privilege for that, which the platform grant provides as
-- UPDATE (id); this restrictive policy turns that privilege into lock-only.
-- Identity writes stay on AUTH_DATABASE_URL. Existing roles and policies are
-- unchanged: the policy only denies updates by vayada_next_api_runtime.
DO $$
DECLARE item regclass;
BEGIN
  FOREACH item IN ARRAY ARRAY[
    'identity.organizations', 'identity.users', 'identity.organization_memberships',
    'identity.role_permission_grants', 'identity.membership_property_assignments',
    'identity.organization_roles'
  ]::regclass[] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = item) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item);
    END IF;
    -- Restrictive policies deny everything unless a permissive policy admits the row.
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = item AND polpermissive) THEN
      EXECUTE format('CREATE POLICY api_runtime_existing_access ON %s
        TO PUBLIC USING (true) WITH CHECK (true)', item);
    END IF;
    EXECUTE format('CREATE POLICY api_runtime_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true)
      WITH CHECK (current_user <> ''vayada_next_api_runtime''
        AND session_user <> ''vayada_next_api_runtime'')', item);
  END LOOP;
END $$;
