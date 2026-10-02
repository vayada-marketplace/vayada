-- VAY-965: distinct property launch-settings purpose. No login or runtime grants.
ALTER TABLE platform.hotel_setup_property_scopes
  DROP CONSTRAINT hotel_setup_property_scopes_operation_class_check,
  ADD CONSTRAINT hotel_setup_property_scopes_operation_class_check
    CHECK (operation_class IN ('currency','currency_ready','feature_hub','launch_settings'));

CREATE OR REPLACE FUNCTION platform.hotel_setup_property_operation_allowed(
  requested_property_id UUID, requested_operation_class TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
BEGIN
  IF requested_operation_class NOT IN ('currency','currency_ready','feature_hub','launch_settings')
    OR NOT platform.hotel_setup_property_allowed(requested_property_id)
  THEN RETURN FALSE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM platform.hotel_setup_property_scopes scope
    WHERE scope.database_login=session_user AND scope.property_id=requested_property_id
      AND scope.operation_class=requested_operation_class AND scope.active
    FOR SHARE OF scope
  );
END $$;

DO $$
DECLARE relation REGCLASS; was_scoped BOOLEAN;
DECLARE ordinary TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_property_'
  AND current_user::text !~ '^vayada_next_hotel_setup_property_'
  AND NOT pg_catalog.pg_has_role(session_user,'vayada_next_hotel_setup_property_scope','MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user,'vayada_next_hotel_setup_property_scope','MEMBER')
$guard$;
DECLARE scoped TEXT := $scope$
  current_user=session_user
  AND pg_catalog.pg_has_role(session_user,'vayada_next_hotel_setup_property_scope','USAGE')
  AND platform.hotel_setup_property_operation_allowed(property_id,'launch_settings')
$scope$;
DECLARE native TEXT := $native$
  current_user=session_user
  AND pg_catalog.pg_has_role(session_user,'vayada_next_hotel_setup_property_scope','USAGE')
$native$;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'booking.booking_settings'::regclass,
    'hotel_catalog.property_contact_channels'::regclass,
    'hotel_catalog.property_public_profile_read_model'::regclass
  ] LOOP
    SELECT relrowsecurity INTO was_scoped FROM pg_catalog.pg_class WHERE oid=relation;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',relation);
    IF NOT was_scoped THEN
      EXECUTE format('CREATE POLICY hotel_setup_launch_existing ON %s TO PUBLIC
        USING (%s) WITH CHECK (%s)',relation,ordinary,ordinary);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_launch_permit ON %s
      TO vayada_next_hotel_setup_property_scope USING (true) WITH CHECK (true)',relation);
    EXECUTE format('CREATE POLICY hotel_setup_launch_guard ON %s AS RESTRICTIVE TO PUBLIC
      USING ((%s) OR (%s)) WITH CHECK ((%s) OR (%s))',relation,ordinary,native,ordinary,native);
    EXECUTE format('CREATE POLICY hotel_setup_launch_read ON %s AS RESTRICTIVE FOR SELECT
      TO vayada_next_hotel_setup_property_scope USING (%s)',relation,scoped);
    IF relation='hotel_catalog.property_contact_channels'::regclass THEN
      EXECUTE format('CREATE POLICY hotel_setup_launch_insert ON %s AS RESTRICTIVE FOR INSERT
        TO vayada_next_hotel_setup_property_scope WITH CHECK (%s AND source_system=''booking''
          AND is_public AND channel_type IN (''instagram'',''facebook'',''tiktok'',''youtube''))',relation,scoped);
      -- UPDATE visibility permits locking a conflicting private social contact. Its source
      -- is immutable to the native column grants, and WITH CHECK forbids publishing it.
      EXECUTE format('CREATE POLICY hotel_setup_launch_update ON %s AS RESTRICTIVE FOR UPDATE
        TO vayada_next_hotel_setup_property_scope
        USING (%s AND channel_type IN (''instagram'',''facebook'',''tiktok'',''youtube''))
        WITH CHECK (%s AND source_system=''booking'' AND is_public
          AND channel_type IN (''instagram'',''facebook'',''tiktok'',''youtube''))',relation,scoped,scoped);
      EXECUTE format('CREATE POLICY hotel_setup_launch_delete ON %s AS RESTRICTIVE FOR DELETE
        TO vayada_next_hotel_setup_property_scope USING (%s AND source_system=''booking''
          AND channel_type IN (''instagram'',''facebook'',''tiktok'',''youtube''))',relation,scoped);
    ELSE
      EXECUTE format('CREATE POLICY hotel_setup_launch_insert_denial ON %s AS RESTRICTIVE FOR INSERT
        TO vayada_next_hotel_setup_property_scope WITH CHECK (false)',relation);
      EXECUTE format('CREATE POLICY hotel_setup_launch_update ON %s AS RESTRICTIVE FOR UPDATE
        TO vayada_next_hotel_setup_property_scope USING (%s) WITH CHECK (%s)',relation,scoped,scoped);
      EXECUTE format('CREATE POLICY hotel_setup_launch_delete_denial ON %s AS RESTRICTIVE FOR DELETE
        TO vayada_next_hotel_setup_property_scope USING (false)',relation);
    END IF;
  END LOOP;
END $$;

-- Preserve the exact existing currency and Feature Hub audit predicates.
DO $$ DECLARE previous TEXT; predicate TEXT; BEGIN
  SELECT pg_catalog.pg_get_expr(polqual,polrelid) INTO STRICT previous FROM pg_catalog.pg_policy
    WHERE polrelid='platform.product_audit_events'::regclass
      AND polname='hotel_setup_currency_evidence_scope';
  predicate := previous || $audit$ OR (
    tenant_scope='property' AND organization_id IS NULL
    AND platform.hotel_setup_property_row_allowed(property_id)
    AND platform.hotel_setup_property_operation_allowed(property_id,'launch_settings')
    AND product='hotel_catalog' AND action='property_launch_settings_updated'
    AND target_resource_product='hotel_catalog' AND target_resource_type='property'
    AND target_resource_id=property_id::text AND actor_type='user'
    AND EXISTS (SELECT 1 FROM identity.users actor JOIN identity.organization_memberships member
      ON member.user_id=actor.id WHERE actor.id=actor_user_id AND actor.status='active'
        AND member.status='active'
        AND member.organization_id=platform.hotel_setup_property_assigned_organization())
    AND audit_metadata=jsonb_build_object('actorOrganizationId',
      platform.hotel_setup_property_assigned_organization()::text,
      'hotelSetupTransaction',pg_catalog.pg_current_xact_id()::text)
    AND redacted_payload='{"operation":"launch_settings"}'::jsonb AND private_payload='{}'::jsonb
    AND domain_event_id IS NULL AND idempotency_key_id IS NULL AND job_id IS NULL
    AND external_webhook_event_id IS NULL AND secondary_resource_product IS NULL
    AND secondary_resource_type IS NULL AND secondary_resource_id IS NULL
    AND retention_class='standard' AND privacy_scope='internal'
  )$audit$;
  EXECUTE format('ALTER POLICY hotel_setup_currency_evidence_scope ON platform.product_audit_events
    USING (%s) WITH CHECK (%s)',predicate,predicate);
END $$;
