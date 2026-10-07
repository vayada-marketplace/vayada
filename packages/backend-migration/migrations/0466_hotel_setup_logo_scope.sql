-- VAY-965: stage actor-bound property-logo authority; no login, credential or media write grant.
ALTER TABLE platform.hotel_setup_property_scopes
  DROP CONSTRAINT hotel_setup_property_scopes_operation_class_check,
  DROP CONSTRAINT hotel_setup_property_login_name,
  ADD COLUMN actor_user_id UUID REFERENCES identity.users(id),
  ADD CONSTRAINT hotel_setup_property_scopes_operation_class_check
    CHECK (operation_class IN ('currency','currency_ready','feature_hub','launch_settings','property_logo')),
  ADD CONSTRAINT hotel_setup_property_login_name CHECK (
    (operation_class='property_logo' AND database_login::text ~ '^vayada_next_hotel_setup_logo_[a-z0-9_]+$')
    OR (operation_class<>'property_logo' AND database_login::text ~ '^vayada_next_hotel_setup_property_[a-z0-9_]+$')
  ),
  ADD CONSTRAINT hotel_setup_property_logo_actor_check
    CHECK ((operation_class='property_logo')=(actor_user_id IS NOT NULL));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='vayada_next_hotel_setup_logo_scope') THEN
    CREATE ROLE vayada_next_hotel_setup_logo_scope NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname='vayada_next_hotel_setup_logo_scope'
      AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'hotel setup logo scope role is unsafe';
  END IF;
END $$;
GRANT USAGE ON SCHEMA platform TO vayada_next_hotel_setup_logo_scope;

CREATE FUNCTION platform.hotel_setup_logo_allowed(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE assignment RECORD; locked_member RECORD; definition RECORD; login_oid OID; parent_oid OID;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR session_user::text !~ '^vayada_next_hotel_setup_logo_[a-z0-9_]+$'
  THEN RETURN FALSE; END IF;
  SELECT oid INTO parent_oid FROM pg_catalog.pg_roles
    WHERE rolname='vayada_next_hotel_setup_logo_scope'
      AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  SELECT oid INTO login_oid FROM pg_catalog.pg_roles
    WHERE rolname=session_user AND rolcanlogin AND rolvaliduntil IS NULL
      AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  IF parent_oid IS NULL OR login_oid IS NULL
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=login_oid)<>1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member=login_oid AND roleid=parent_oid AND inherit_option AND NOT set_option AND NOT admin_option)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=login_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting WHERE setting.setrole IN (login_oid,parent_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refclassid='pg_catalog.pg_authid'::regclass AND dependency.refobjid=login_oid
        AND dependency.deptype='o' AND (dependency.dbid=0 OR dependency.dbid=(
          SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())))
  THEN RETURN FALSE; END IF;

  SELECT scope.property_id, scope.organization_id, scope.actor_user_id INTO assignment
    FROM platform.hotel_setup_property_scopes scope
    JOIN identity.organizations organization ON organization.id=scope.organization_id
    WHERE scope.database_login=session_user AND scope.active AND scope.operation_class='property_logo'
      AND scope.property_id=requested_property_id AND scope.organization_id=requested_organization_id
      AND scope.actor_user_id=requested_actor_user_id AND scope.credential_role_oid=login_oid
      AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL
      AND organization.kind='hotel_group' AND organization.status='active'
    -- ponytail: reuse the existing organization-wide setup lock to serialize revocation.
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
    OR NOT EXISTS (SELECT 1 FROM identity.users actor
      WHERE actor.id=assignment.actor_user_id AND actor.status='active' FOR SHARE)
    OR NOT (locked_member.property_access_mode='all' OR (locked_member.property_access_mode='assigned'
      AND EXISTS (SELECT 1 FROM identity.membership_property_assignments property_assignment
        WHERE property_assignment.membership_id=locked_member.id AND property_assignment.property_id=assignment.property_id FOR SHARE)))
  THEN RETURN FALSE; END IF;
  RETURN EXISTS (SELECT 1 FROM identity.organization_resource_links owner_link
    WHERE owner_link.organization_id=assignment.organization_id AND owner_link.product='hotel_catalog'
      AND owner_link.resource_type='property' AND lower(owner_link.resource_id)=assignment.property_id::text
      AND owner_link.relationship='owner' AND owner_link.status='active' FOR SHARE);
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_logo_allowed(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_logo_allowed(UUID,UUID,UUID) TO vayada_next_hotel_setup_logo_scope;

CREATE FUNCTION platform.hotel_setup_logo_row_allowed(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
  IF current_user<>session_user THEN RETURN FALSE; END IF;
  RETURN platform.hotel_setup_logo_allowed(requested_property_id,requested_organization_id,requested_actor_user_id);
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_logo_row_allowed(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_logo_row_allowed(UUID,UUID,UUID) TO vayada_next_hotel_setup_logo_scope;
