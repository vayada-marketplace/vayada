-- VAY-1092: native currency dependency reads belong to one hotel's purpose.
-- Preserve existing ACL-backed callers; no login or table/function grant.
DO $$
DECLARE relation regclass;
DECLARE non_setup TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_property_'
  AND current_user::text !~ '^vayada_next_hotel_setup_property_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
$guard$;
BEGIN
  FOREACH relation IN ARRAY ARRAY['pms.room_types'::regclass, 'pms.rate_plans'::regclass,
    'pms.rate_rules'::regclass, 'pms.recurring_pricing_sources'::regclass] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid=relation) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', relation);
      EXECUTE format('CREATE POLICY hotel_setup_dependency_existing_callers ON %s
        TO PUBLIC USING (true) WITH CHECK (true)', relation);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_currency_dependency_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user=session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_property_scope'', ''USAGE'')))
      WITH CHECK (%s)', relation, non_setup, non_setup);
    EXECUTE format('CREATE POLICY hotel_setup_currency_dependency_scope ON %s
      AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
      USING (platform.hotel_setup_property_row_allowed(property_id)
        AND (platform.hotel_setup_property_operation_allowed(property_id, ''currency'')
          OR platform.hotel_setup_property_operation_allowed(property_id, ''currency_ready'')))
      WITH CHECK (false)', relation);
    EXECUTE format('CREATE POLICY hotel_setup_currency_dependency_delete_denial ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', relation, non_setup);
  END LOOP;
END $$;
