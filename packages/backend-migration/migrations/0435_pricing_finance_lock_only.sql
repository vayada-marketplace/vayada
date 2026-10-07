-- VAY-1543: pricing may lock Finance readiness evidence, not edit it.
-- Channex already enabled RLS on these relations; retain its policies.
DO $$
DECLARE relation regclass;
DECLARE scoped_read text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'finance.payment_settings'::regclass,
    'finance.payment_provider_accounts'::regclass,
    'finance.online_card_execution_evidence'::regclass
  ] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = relation) THEN
      RAISE EXCEPTION 'pricing lock relation lacks RLS: %', relation;
    END IF;
    scoped_read := format($scope$
      (session_user::text !~ '^vayada_next_pricing_'
        AND current_user::text !~ '^vayada_next_pricing_'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles pricing_role
          WHERE pricing_role.rolname ~ '^vayada_next_pricing_'
            AND pg_catalog.pg_has_role(session_user, pricing_role.oid, 'member')
        ))
      OR EXISTS (
        SELECT 1 FROM booking.pricing_runtime_effective_property_scopes scope
        WHERE scope.property_id = %s.property_id
      )
    $scope$, relation);
    EXECUTE format('CREATE POLICY pricing_runtime_finance_read_scope ON %s
      AS RESTRICTIVE FOR SELECT TO PUBLIC USING (%s)', relation, scoped_read);
    EXECUTE format('CREATE POLICY pricing_runtime_finance_update_scope ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (%s)', relation, scoped_read);
    EXECUTE format('CREATE POLICY pricing_runtime_finance_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (
        session_user::text !~ ''^vayada_next_pricing_''
        AND current_user::text !~ ''^vayada_next_pricing_''
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles pricing_role
          WHERE pricing_role.rolname ~ ''^vayada_next_pricing_''
            AND pg_catalog.pg_has_role(session_user, pricing_role.oid, ''member'')
        )
      )', relation);
  END LOOP;
END $$;
