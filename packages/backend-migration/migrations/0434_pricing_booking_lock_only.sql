-- VAY-1543: a pricing login may lock current Booking evidence, not edit it.
-- These relations already use RLS for the Channex worker; keep those policies.
DO $$
DECLARE relation regclass;
DECLARE scoped_read text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'booking.pricing_v2_offer_term_heads'::regclass,
    'booking.pricing_v2_offer_terms'::regclass,
    'booking.fixed_charge_heads'::regclass,
    'booking.fixed_charge_revisions'::regclass
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
    EXECUTE format('CREATE POLICY pricing_runtime_booking_read_scope ON %s
      AS RESTRICTIVE FOR SELECT TO PUBLIC USING (%s)', relation, scoped_read);
    IF relation = 'booking.pricing_v2_offer_terms'::regclass THEN CONTINUE; END IF;
    EXECUTE format('CREATE POLICY pricing_runtime_booking_update_scope ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (%s)', relation, scoped_read);
    EXECUTE format('CREATE POLICY pricing_runtime_booking_lock_only ON %s
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
