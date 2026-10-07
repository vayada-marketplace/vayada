-- VAY-965: actor-bound property profile-edit purpose. Its login receives no table
-- privilege; the fixed definer functions below are its only data path.
-- No login, credential, assignment or ordinary runtime grant is created here.
ALTER TABLE platform.hotel_setup_property_scopes
  DROP CONSTRAINT hotel_setup_property_scopes_operation_class_check,
  DROP CONSTRAINT hotel_setup_property_login_name,
  DROP CONSTRAINT hotel_setup_property_logo_actor_check,
  ADD CONSTRAINT hotel_setup_property_scopes_operation_class_check CHECK (operation_class IN
    ('currency','currency_ready','feature_hub','launch_settings','property_logo','property_profile')),
  ADD CONSTRAINT hotel_setup_property_login_name CHECK (
    (operation_class='property_logo' AND database_login::text ~ '^vayada_next_hotel_setup_logo_[a-z0-9_]+$')
    OR (operation_class='property_profile' AND database_login::text ~ '^vayada_next_hotel_setup_profile_[a-z0-9_]+$')
    OR (operation_class NOT IN ('property_logo','property_profile')
      AND database_login::text ~ '^vayada_next_hotel_setup_property_[a-z0-9_]+$')
  ),
  ADD CONSTRAINT hotel_setup_property_logo_actor_check
    CHECK ((operation_class IN ('property_logo','property_profile'))=(actor_user_id IS NOT NULL));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_profile_scope') THEN
    CREATE ROLE vayada_next_hotel_setup_profile_scope NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='vayada_next_hotel_setup_profile_scope'
      AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'hotel setup profile scope role is unsafe';
  END IF;
END $$;
GRANT USAGE ON SCHEMA platform TO vayada_next_hotel_setup_profile_scope;

-- Same original-Owner authority as the logo purpose, plus publication permission
-- because a profile edit can change the public locality and contacts.
CREATE FUNCTION platform.hotel_setup_profile_authority(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID, allow_pending BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE assignment RECORD; locked_member RECORD; definition RECORD; login_oid OID; parent_oid OID;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR session_user::text !~ '^vayada_next_hotel_setup_profile_[a-z0-9_]+$'
  THEN RETURN FALSE; END IF;
  SELECT oid INTO parent_oid FROM pg_catalog.pg_roles
    WHERE rolname='vayada_next_hotel_setup_profile_scope'
      AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  SELECT oid INTO login_oid FROM pg_catalog.pg_roles
    WHERE rolname=session_user AND rolcanlogin AND rolvaliduntil IS NULL
      AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  IF parent_oid IS NULL OR login_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=parent_oid)
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=login_oid)<>1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member=login_oid AND roleid=parent_oid AND inherit_option AND NOT set_option AND NOT admin_option)
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid=login_oid)>1
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members edge
      JOIN pg_catalog.pg_roles administrator ON administrator.oid=edge.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=edge.grantor
      WHERE edge.roleid=login_oid AND NOT
        (administrator.rolname='vayada_admin' AND administrator.rolcanlogin AND administrator.rolcreaterole
          AND NOT administrator.rolsuper
          AND edge.admin_option AND NOT edge.inherit_option AND NOT edge.set_option AND grantor.rolsuper))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting WHERE setting.setrole IN (login_oid,parent_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refclassid='pg_catalog.pg_authid'::regclass AND dependency.refobjid=login_oid
        AND dependency.deptype='o' AND (dependency.dbid=0 OR dependency.dbid=(
          SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())))
  THEN RETURN FALSE; END IF;

  SELECT scope.property_id, scope.organization_id, scope.actor_user_id INTO assignment
    FROM platform.hotel_setup_property_scopes scope
    JOIN identity.organizations organization ON organization.id=scope.organization_id
    WHERE scope.database_login=session_user AND scope.active AND scope.operation_class='property_profile'
      AND scope.property_id=requested_property_id AND scope.organization_id=requested_organization_id
      AND scope.actor_user_id=requested_actor_user_id
      AND ((allow_pending AND scope.credential_role_oid IS NULL AND scope.credential_secret_version IS NULL AND scope.credential_ready_at IS NULL)
        OR (NOT allow_pending AND scope.credential_role_oid=login_oid AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL))
      AND organization.kind='hotel_group' AND organization.status='active'
    -- Reuse the organization-wide setup lock: serializes revocation and concurrent edits.
    FOR UPDATE OF organization FOR SHARE OF scope;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT membership.* INTO locked_member FROM identity.organization_memberships membership
    WHERE membership.organization_id=assignment.organization_id AND membership.user_id=assignment.actor_user_id
      AND membership.status='active' FOR SHARE;
  IF NOT FOUND OR locked_member.role_key<>'hotel_owner'
    OR (locked_member.permission_overrides IS NOT NULL AND locked_member.permission_overrides<>'{"grant":[],"deny":[]}'::jsonb)
  THEN RETURN FALSE; END IF;
  IF locked_member.role_definition_id IS NOT NULL THEN
    SELECT role.* INTO definition FROM identity.organization_roles role
      WHERE role.id=locked_member.role_definition_id AND role.organization_id=assignment.organization_id FOR SHARE;
    IF NOT FOUND OR definition.security_class<>'account_admin' OR definition.base_role_key<>'hotel_owner'
      OR definition.preset_key IS DISTINCT FROM 'account_admin' OR definition.default_permissions<>'[]'::jsonb
    THEN RETURN FALSE; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.role_permission_grants permission
      WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
        AND permission.permission_key='hotel_catalog.setup.manage' FOR SHARE)
    OR NOT EXISTS (SELECT 1 FROM identity.role_permission_grants permission
      WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
        AND permission.permission_key='marketplace.profile.manage' FOR SHARE)
    OR NOT EXISTS (SELECT 1 FROM identity.users actor
      WHERE actor.id=assignment.actor_user_id AND actor.status='active' FOR SHARE)
    OR NOT (locked_member.property_access_mode='all' OR (locked_member.property_access_mode='assigned'
      AND EXISTS (SELECT 1 FROM identity.membership_property_assignments property_assignment
        WHERE property_assignment.membership_id=locked_member.id AND property_assignment.property_id=assignment.property_id FOR SHARE)))
  THEN RETURN FALSE; END IF;
  RETURN EXISTS (SELECT 1 FROM identity.organization_resource_links owner_link
    JOIN hotel_catalog.properties property ON property.id=assignment.property_id AND property.lifecycle_status<>'retired'
    WHERE owner_link.organization_id=assignment.organization_id AND owner_link.product='hotel_catalog'
      AND owner_link.resource_type='property' AND lower(owner_link.resource_id)=assignment.property_id::text
      AND owner_link.relationship='owner' AND owner_link.status='active' FOR SHARE OF owner_link,property);
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_profile_authority(UUID,UUID,UUID,BOOLEAN) FROM PUBLIC;

CREATE FUNCTION platform.hotel_setup_profile_allowed(property UUID, organization UUID, actor UUID)
RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT platform.hotel_setup_profile_authority(property,organization,actor,FALSE);
$$;
-- Protected credential proof only; a pending assignment can never write.
CREATE FUNCTION platform.hotel_setup_profile_bootstrap_proof_allowed(property UUID, organization UUID, actor UUID)
RETURNS BOOLEAN LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT platform.hotel_setup_profile_authority(property,organization,actor,TRUE);
$$;

-- Same row shape and contact visibility as the shared profile GET.
CREATE FUNCTION platform.hotel_setup_property_profile_row(requested_property_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'propertyId', property.id::text,
    'profileRevision', property.profile_revision,
    'displayName', NULLIF(property.display_name, ''),
    'propertyType', NULLIF(property.property_type, ''),
    'countryCode', NULLIF(location.country_code::text, ''),
    'city', NULLIF(location.city, ''),
    'streetAddress', NULLIF(location.street_address, ''),
    'postalCode', NULLIF(location.postal_code, ''),
    'timezone', NULLIF(location.timezone, ''),
    'latitude', location.latitude,
    'longitude', location.longitude,
    'localityPublic', COALESCE(location.address_public, FALSE),
    'geoPublic', COALESCE(location.geo_public, FALSE),
    'mapDisplayMode', COALESCE(location.map_display_mode, 'hidden'),
    'contacts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'channelType', contact.channel_type, 'value', contact.value,
        'purpose', contact.purpose, 'isPublic', contact.is_public)
        ORDER BY contact.channel_type, contact.value, contact.created_at, contact.id)
      FROM hotel_catalog.property_contact_channels contact
      WHERE contact.property_id = property.id
        AND (contact.source_system = 'platform' OR (contact.is_public = TRUE
          AND contact.channel_type IN ('phone', 'whatsapp', 'email')))), '[]'::jsonb))
  FROM hotel_catalog.properties property
  LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
  WHERE property.id = requested_property_id;
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_property_profile_row(UUID) FROM PUBLIC;

-- Authority denials use the dedicated SQLSTATE HSP03, so a missing grant or policy
-- (42501) surfaces as unavailable instead of an Owner-facing denial.
CREATE FUNCTION platform.hotel_setup_property_profile_snapshot(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT platform.hotel_setup_profile_authority(requested_property_id,requested_organization_id,requested_actor_user_id,FALSE)
  THEN RAISE EXCEPTION 'hotel setup profile forbidden' USING ERRCODE='HSP03'; END IF;
  RETURN platform.hotel_setup_property_profile_row(requested_property_id);
END $$;

DO $$ DECLARE signature TEXT; BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'platform.hotel_setup_profile_allowed(uuid,uuid,uuid)',
    'platform.hotel_setup_profile_bootstrap_proof_allowed(uuid,uuid,uuid)',
    'platform.hotel_setup_property_profile_snapshot(uuid,uuid,uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO vayada_next_hotel_setup_profile_scope', signature);
  END LOOP;
END $$;
