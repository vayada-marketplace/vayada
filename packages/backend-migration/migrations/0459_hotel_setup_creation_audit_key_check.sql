-- VAY-965: audit policies must not require broad retry-table SELECT for xmin.
CREATE FUNCTION platform.hotel_setup_creation_audit_key_allowed(
  requested_key UUID, requested_organization UUID, requested_correlation TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE assigned_organization UUID;
BEGIN
  assigned_organization := platform.hotel_setup_creation_assigned_organization();
  IF assigned_organization IS NULL OR assigned_organization <> requested_organization THEN RETURN FALSE; END IF;
  PERFORM 1 FROM platform.idempotency_keys key
  WHERE key.id = requested_key AND key.organization_id = assigned_organization
    AND key.tenant_scope = 'organization' AND key.property_id IS NULL
    AND key.operation_scope = 'hotel_catalog' AND key.operation = 'hotel_setup.property.create'
    AND key.status = 'in_progress' AND key.xmin = pg_current_xact_id()::xid
    AND key.correlation_id = requested_correlation FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_creation_audit_key_allowed(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_creation_audit_key_allowed(UUID, UUID, TEXT)
  TO vayada_next_hotel_setup_scope;

ALTER POLICY hotel_setup_creation_audit_insert ON platform.product_audit_events WITH CHECK (
    tenant_scope = 'organization' AND property_id IS NULL
    AND organization_id = platform.hotel_setup_creation_assigned_organization()
    AND product = 'hotel_catalog' AND action = 'hotel_setup.property.create' AND action_version = 1
    AND actor_type = 'user'
    AND EXISTS (SELECT 1 FROM identity.organization_memberships membership
      JOIN identity.users actor ON actor.id = membership.user_id
      WHERE membership.organization_id = product_audit_events.organization_id
        AND membership.user_id = actor_user_id AND membership.status = 'active' AND actor.status = 'active')
    AND target_resource_product = 'hotel_catalog' AND target_resource_type = 'property'
    AND EXISTS (SELECT 1 FROM hotel_catalog.properties property
      WHERE platform.hotel_setup_property_link_matches(property.id, target_resource_id)
        AND platform.hotel_setup_new_property_allowed(property.id))
    AND secondary_resource_product IS NULL AND secondary_resource_type IS NULL AND secondary_resource_id IS NULL
    AND domain_event_id IS NULL AND external_webhook_event_id IS NULL AND job_id IS NULL
    AND platform.hotel_setup_creation_audit_key_allowed(idempotency_key_id, organization_id, correlation_id)
    AND audit_key = 'hotel-setup-property-create:' || idempotency_key_id::text
    AND redacted_payload = '{"outcome":"created"}'::jsonb
    AND private_payload = '{"targetAccountUserId":null,"provisioningReference":null,"reason":null}'::jsonb
    AND audit_metadata = jsonb_build_object('organizationId', organization_id::text)
    AND retention_class = 'standard' AND privacy_scope = 'confidential' AND NOT ai_visible
    AND recorded_at = now()
  );
