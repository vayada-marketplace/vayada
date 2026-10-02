-- VAY-965: creation retries and audit evidence share the native organization scope.
-- Runtime grants and credentials remain separate release prerequisites.
DO $$
DECLARE relation REGCLASS;
DECLARE non_creation TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_org_'
  AND current_user::text !~ '^vayada_next_hotel_setup_org_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
$guard$;
BEGIN
  FOREACH relation IN ARRAY ARRAY['platform.idempotency_keys'::regclass,
    'platform.product_audit_events'::regclass] LOOP
    EXECUTE format('CREATE POLICY hotel_setup_creation_evidence_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))
      WITH CHECK ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_scope'', ''USAGE'')))',
      relation, non_creation, non_creation);
    EXECUTE format('CREATE POLICY hotel_setup_creation_evidence_delete_denial ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', relation, non_creation);
  END LOOP;
END $$;

CREATE POLICY hotel_setup_creation_key_permit ON platform.idempotency_keys
  TO vayada_next_hotel_setup_scope USING (true) WITH CHECK (true);
CREATE POLICY hotel_setup_creation_key_read ON platform.idempotency_keys
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (
    tenant_scope = 'organization' AND property_id IS NULL
    AND organization_id = platform.hotel_setup_creation_assigned_organization()
    AND operation_scope = 'hotel_catalog' AND operation = 'hotel_setup.property.create'
    AND key_hash ~ '^[a-f0-9]{64}$' AND request_fingerprint_hash ~ '^[a-f0-9]{64}$'
    AND idempotency_metadata = '{}'::jsonb AND NOT ai_visible
    AND response_body_hash IS NULL
    AND (status = 'in_progress' OR (status = 'completed'
      AND response_status_code = 201 AND response_resource_product = 'hotel_catalog'
      AND response_resource_type = 'property'
      AND EXISTS (SELECT 1 FROM hotel_catalog.properties property
        WHERE platform.hotel_setup_property_link_matches(property.id, response_resource_id)
          AND platform.hotel_setup_property_read_allowed(property.id, property.creation_organization_id))))
  );
CREATE POLICY hotel_setup_creation_key_insert ON platform.idempotency_keys
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (
    tenant_scope = 'organization' AND property_id IS NULL
    AND organization_id = platform.hotel_setup_creation_assigned_organization()
    AND operation_scope = 'hotel_catalog' AND operation = 'hotel_setup.property.create'
    AND key_hash ~ '^[a-f0-9]{64}$' AND request_fingerprint_hash ~ '^[a-f0-9]{64}$'
    AND status = 'in_progress' AND response_status_code IS NULL AND response_body_hash IS NULL
    AND response_resource_product IS NULL AND response_resource_type IS NULL AND response_resource_id IS NULL
    AND completed_at IS NULL AND locked_until IS NULL
    AND idempotency_metadata = '{}'::jsonb AND NOT ai_visible
    AND first_seen_at = now() AND last_seen_at = now() AND expires_at = now() + interval '24 hours'
  );
-- Completed rows remain lockable for replay; the trigger below denies actual updates.
CREATE POLICY hotel_setup_creation_key_update ON platform.idempotency_keys
  AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_scope USING (
    tenant_scope = 'organization' AND property_id IS NULL
    AND organization_id = platform.hotel_setup_creation_assigned_organization()
    AND operation_scope = 'hotel_catalog' AND operation = 'hotel_setup.property.create'
    AND (status = 'completed' OR (status = 'in_progress' AND xmin = pg_current_xact_id()::xid))
  ) WITH CHECK (
    status = 'completed' AND response_status_code = 201
    AND response_resource_product = 'hotel_catalog' AND response_resource_type = 'property'
    AND EXISTS (SELECT 1 FROM hotel_catalog.properties property
      WHERE platform.hotel_setup_property_link_matches(property.id, response_resource_id)
        AND platform.hotel_setup_new_property_allowed(property.id))
    AND completed_at = now() AND last_seen_at = now()
  );
CREATE FUNCTION platform.guard_hotel_setup_creation_key_completion()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF session_user::text !~ '^vayada_next_hotel_setup_org_'
    AND (NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_scope', 'MEMBER')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = session_user AND rolsuper))
  THEN RETURN NEW; END IF;
  IF OLD.status <> 'in_progress' OR
    (to_jsonb(OLD) - ARRAY['scope_key','status','response_status_code','response_resource_product',
      'response_resource_type','response_resource_id','completed_at','last_seen_at']) IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['scope_key','status','response_status_code','response_resource_product',
      'response_resource_type','response_resource_id','completed_at','last_seen_at'])
  THEN RAISE EXCEPTION 'Hotel setup creation retry mutation denied' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.product_audit_events audit
    WHERE audit.idempotency_key_id = OLD.id AND audit.organization_id = OLD.organization_id
      AND audit.product = 'hotel_catalog' AND audit.action = 'hotel_setup.property.create'
      AND audit.target_resource_product = NEW.response_resource_product
      AND audit.target_resource_type = NEW.response_resource_type
      AND audit.target_resource_id = NEW.response_resource_id
      AND audit.audit_key = 'hotel-setup-property-create:' || OLD.id::text
      AND audit.correlation_id = OLD.correlation_id
      AND audit.xmin = pg_current_xact_id()::xid)
  THEN RAISE EXCEPTION 'Hotel setup creation completion evidence missing' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_hotel_setup_creation_key_completion() FROM PUBLIC;
CREATE TRIGGER hotel_setup_creation_key_completion BEFORE UPDATE ON platform.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION platform.guard_hotel_setup_creation_key_completion();
ALTER TABLE platform.idempotency_keys ENABLE ALWAYS TRIGGER hotel_setup_creation_key_completion;

CREATE POLICY hotel_setup_creation_audit_permit ON platform.product_audit_events
  FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (true);
CREATE POLICY hotel_setup_creation_audit_read ON platform.product_audit_events
  AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_scope USING (false);
CREATE POLICY hotel_setup_creation_audit_update ON platform.product_audit_events
  AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_scope USING (false) WITH CHECK (false);
CREATE POLICY hotel_setup_creation_audit_insert ON platform.product_audit_events
  AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_scope WITH CHECK (
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
    AND EXISTS (SELECT 1 FROM platform.idempotency_keys key
      WHERE key.id = idempotency_key_id AND key.organization_id = product_audit_events.organization_id
        AND key.status = 'in_progress' AND key.xmin = pg_current_xact_id()::xid
        AND key.correlation_id = product_audit_events.correlation_id)
    AND audit_key = 'hotel-setup-property-create:' || idempotency_key_id::text
    AND redacted_payload = '{"outcome":"created"}'::jsonb
    AND private_payload = '{"targetAccountUserId":null,"provisioningReference":null,"reason":null}'::jsonb
    AND audit_metadata = jsonb_build_object('organizationId', organization_id::text)
    AND retention_class = 'standard' AND privacy_scope = 'confidential' AND NOT ai_visible
    AND recorded_at = now()
  );
