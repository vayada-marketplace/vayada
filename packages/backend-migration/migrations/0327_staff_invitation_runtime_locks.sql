-- VAY-2038: lock-only entry points for the restricted API role.
-- The caller retains its transaction and performs authorization after locking.

CREATE FUNCTION identity.lock_staff_invitation_manager(p_organization_id uuid, p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM id FROM identity.organizations
   WHERE id = p_organization_id AND kind = 'hotel_group' AND status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM membership.id
    FROM identity.organization_memberships membership
    JOIN identity.organizations organization ON organization.id = membership.organization_id
    JOIN identity.users actor ON actor.id = membership.user_id
   WHERE membership.organization_id = p_organization_id AND membership.user_id = p_actor_id
     AND membership.status = 'active' AND organization.kind = 'hotel_group'
     AND organization.status = 'active' AND actor.status = 'active'
   FOR UPDATE OF membership, organization, actor;
END;
$$;

CREATE FUNCTION identity.lock_staff_invitation_organization(p_provider_invitation_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM organization.id
    FROM identity.organizations organization
    JOIN identity.staff_invitations invitation ON invitation.organization_id = organization.id
   WHERE invitation.provider_invitation_id = p_provider_invitation_id
   FOR UPDATE OF organization;
END;
$$;

CREATE FUNCTION identity.lock_staff_invitation_identity(p_provider_user_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM external.id
    FROM identity.external_identities external
    JOIN identity.users users ON users.id = external.user_id
   WHERE external.provider = 'workos' AND external.provider_user_id = p_provider_user_id
   FOR SHARE OF external, users;
END;
$$;

CREATE FUNCTION identity.lock_staff_invitation_property_scope(p_invitation_id uuid, p_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM assignment.property_id
    FROM identity.staff_invitation_property_assignments assignment
    JOIN identity.organization_resource_links link
      ON link.organization_id = p_organization_id AND link.product = 'hotel_catalog'
     AND link.resource_type = 'property' AND link.resource_id = assignment.property_id::text
     AND link.relationship IN ('owner', 'operator') AND link.status = 'active'
   WHERE assignment.invitation_id = p_invitation_id
   FOR SHARE OF assignment, link;
END;
$$;

CREATE FUNCTION identity.lock_staff_invitation_role(p_organization_id uuid, p_role_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM id FROM identity.organization_roles
   WHERE organization_id = p_organization_id AND id = p_role_id
   FOR SHARE;
END;
$$;

REVOKE ALL ON FUNCTION identity.lock_staff_invitation_manager(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.lock_staff_invitation_organization(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.lock_staff_invitation_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.lock_staff_invitation_property_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.lock_staff_invitation_role(uuid, uuid) FROM PUBLIC;
