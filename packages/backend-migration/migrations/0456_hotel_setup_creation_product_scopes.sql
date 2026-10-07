-- VAY-965: stage creation-only product defaults and current setup/billing reads.
-- No native login or runtime write grant is introduced.
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
    ('hotel_catalog.organization_setup_track_intents'::regclass,
      'organization_id = platform.hotel_setup_creation_assigned_organization()', NULL::text),
    ('finance.billing_entitlements'::regclass,
      'organization_id = platform.hotel_setup_creation_assigned_organization()
       AND product IN (''booking'', ''pms'', ''marketplace'')
       AND entitlement_key IN (''booking-engine'', ''property-management'',
         ''marketplace-hotel-profile'', ''account_access'', ''pms-core'')', NULL::text),
    ('booking.booking_settings'::regclass,
      'EXISTS (SELECT 1 FROM hotel_catalog.properties property
        WHERE property.id = booking_settings.property_id
          AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id))',
      'platform.hotel_setup_new_property_allowed(property_id)
       AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
         WHERE link.organization_id = platform.hotel_setup_creation_assigned_organization()
           AND link.product = ''booking'' AND link.resource_type = ''booking_hotel''
           AND link.resource_id = property_id::text AND link.relationship = ''owner'' AND link.status = ''active'')'),
    ('marketplace.marketplace_hotel_profiles'::regclass,
      'organization_id = platform.hotel_setup_creation_assigned_organization()
       AND EXISTS (SELECT 1 FROM hotel_catalog.properties property
         WHERE property.id = marketplace_hotel_profiles.property_id
           AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id))',
      'platform.hotel_setup_new_property_allowed(property_id)
       AND organization_id = platform.hotel_setup_creation_assigned_organization()
       AND source_system = ''marketplace'' AND source_hotel_profile_id = property_id::text
       AND marketplace_profile_status = ''pending'' AND NOT profile_complete
       AND profile_completed_at IS NULL AND host_summary IS NULL AND collaboration_guidelines IS NULL
       AND marketplace_metadata = ''{}''::jsonb
       AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
         WHERE link.organization_id = marketplace_hotel_profiles.organization_id
           AND link.product = ''marketplace'' AND link.resource_type = ''hotel_profile''
           AND link.resource_id = property_id::text AND link.relationship = ''owner'' AND link.status = ''active'')')
  ) AS scope(relation, predicate, insertion) LOOP
    SELECT relrowsecurity INTO was_scoped FROM pg_catalog.pg_class WHERE oid = item.relation;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.relation);
    IF NOT was_scoped THEN
      EXECUTE format('CREATE POLICY hotel_setup_creation_product_compat ON %s
        TO PUBLIC USING (%s) WITH CHECK (%s)', item.relation, non_creation, non_creation);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_permit ON %s
      TO vayada_next_hotel_setup_scope USING (true) WITH CHECK (true)', item.relation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))
      WITH CHECK ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))',
      item.relation, non_creation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_read ON %s
      AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (%s)', item.relation, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_insert ON %s
      AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (%s)',
      item.relation, COALESCE(item.insertion, 'false'));
    -- Setup/billing row locks remain available, while actual changes are denied.
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_update ON %s
      AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_scope USING (%s) WITH CHECK (false)',
      item.relation, CASE WHEN item.insertion IS NULL THEN item.predicate ELSE 'false' END);
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_lock_only ON %s
      AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (true) WITH CHECK (%s)', item.relation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_product_delete ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', item.relation, non_creation);
  END LOOP;
END $$;
