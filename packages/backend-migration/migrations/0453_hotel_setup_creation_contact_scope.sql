-- VAY-965: stage organization-native creation guards, without runtime grants.
-- Child inserts belong only to a property inserted in this transaction.
CREATE FUNCTION platform.hotel_setup_new_property_allowed(requested_property_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assigned_organization UUID;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN FALSE; END IF;
  SELECT scope.organization_id INTO assigned_organization
  FROM platform.hotel_setup_creation_scopes scope
  JOIN identity.organizations organization ON organization.id = scope.organization_id
  WHERE scope.database_login = session_user
    AND organization.kind = 'hotel_group' AND organization.status = 'active'
  FOR UPDATE OF organization FOR SHARE OF scope;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  RETURN EXISTS (
    SELECT 1 FROM hotel_catalog.properties property
    WHERE property.id = requested_property_id
      AND property.creation_organization_id = assigned_organization
      AND property.xmin = pg_current_xact_id()::xid
      AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id)
  );
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_new_property_allowed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_new_property_allowed(UUID)
  TO vayada_next_hotel_setup_scope;

DO $$
DECLARE relation TEXT; was_scoped BOOLEAN; ordinary_login TEXT; native_login TEXT;
BEGIN
  ordinary_login := '(session_user::text !~ ''^vayada_next_hotel_setup_org_''
    AND current_user::text !~ ''^vayada_next_hotel_setup_org_''
    AND NOT pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''MEMBER'')
    AND NOT pg_catalog.pg_has_role(current_user, ''vayada_next_hotel_setup_scope'', ''MEMBER''))';
  native_login := '(current_user = session_user
    AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE''))';
  FOREACH relation IN ARRAY ARRAY[
    'hotel_catalog.property_locations', 'hotel_catalog.property_contact_channels',
    'hotel_catalog.property_owner_revisions'
  ] LOOP
    SELECT relrowsecurity INTO was_scoped FROM pg_catalog.pg_class WHERE oid = relation::regclass;
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', relation);
    -- Preserve ACL-backed behavior only on relations that previously had no RLS.
    IF NOT was_scoped THEN
      EXECUTE format('CREATE POLICY hotel_setup_creation_compat ON %s TO PUBLIC USING (%s) WITH CHECK (%s)',
        relation, ordinary_login, ordinary_login);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_creation_permit ON %s TO vayada_next_hotel_setup_scope USING (true) WITH CHECK (true)', relation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_child_guard ON %s AS RESTRICTIVE TO PUBLIC USING (%s OR %s) WITH CHECK (%s OR %s)',
      relation, ordinary_login, native_login, ordinary_login, native_login);
    EXECUTE format('CREATE POLICY hotel_setup_creation_child_read ON %s AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (EXISTS (SELECT 1 FROM hotel_catalog.properties property WHERE property.id = property_id AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id)))', relation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_child_insert ON %s AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (platform.hotel_setup_new_property_allowed(property_id)%s)',
      relation, CASE WHEN relation = 'hotel_catalog.property_owner_revisions' THEN ' AND owner_key = ''hotel_catalog.location''' ELSE '' END);
    IF relation = 'hotel_catalog.property_owner_revisions' THEN
      -- The existing location insert trigger advances this revision in the same transaction.
      EXECUTE format('CREATE POLICY hotel_setup_creation_child_update ON %s AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_scope USING (owner_key = ''hotel_catalog.location'' AND platform.hotel_setup_new_property_allowed(property_id)) WITH CHECK (owner_key = ''hotel_catalog.location'' AND platform.hotel_setup_new_property_allowed(property_id))', relation);
    ELSE
      EXECUTE format('CREATE POLICY hotel_setup_creation_child_update ON %s AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (%s) WITH CHECK (%s)',
        relation, ordinary_login, ordinary_login);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_creation_child_delete ON %s AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', relation, ordinary_login);
  END LOOP;
END $$;
