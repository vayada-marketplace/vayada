-- VAY-965: identical rejection-only audit boundary for the isolated creation reader.
-- No login, grant or service activation is created.
CREATE OR REPLACE FUNCTION platform.hotel_setup_reader_audit_allowed(candidate platform.product_audit_events)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF session_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader')
    AND current_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader') THEN RETURN true; END IF;
  IF session_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader')
    OR current_user <> session_user THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM (SELECT (candidate).*) AS product_audit_events
    WHERE product = 'identity' AND action = 'identity.staff.permission_override.rejected'
    AND action_version = 1 AND tenant_scope = 'organization' AND property_id IS NULL
    AND actor_type = 'user' AND target_resource_product = 'identity'
    AND target_resource_type = 'organization_membership'
    AND EXISTS (SELECT 1 FROM identity.organization_memberships m
      JOIN identity.users u ON u.id = m.user_id
      JOIN identity.organizations o ON o.id = m.organization_id
      WHERE m.id::text = product_audit_events.target_resource_id
        AND m.user_id = product_audit_events.actor_user_id
        AND m.organization_id = product_audit_events.organization_id
        AND m.status = 'active' AND u.status = 'active' AND o.status = 'active')
    AND retention_class = 'security' AND privacy_scope = 'confidential' AND NOT ai_visible
    AND private_payload = '{}'::jsonb AND domain_event_id IS NULL
    AND external_webhook_event_id IS NULL AND job_id IS NULL AND idempotency_key_id IS NULL
    AND secondary_resource_product IS NULL AND secondary_resource_type IS NULL
    AND secondary_resource_id IS NULL AND causation_id IS NULL
    AND redacted_payload - 'issueCodes' =
      '{"outcome":"denied","code":"invalid_permission_override"}'::jsonb
    AND CASE WHEN pg_catalog.jsonb_typeof(redacted_payload->'issueCodes') = 'array'
      THEN pg_catalog.jsonb_array_length(redacted_payload->'issueCodes') > 0
        AND redacted_payload->'issueCodes' <@ '["invalid_role_definition", "malformed_permission_override",
          "invalid_role", "unknown_permission_key", "duplicate_permission_key",
          "conflicting_permission_override", "forbidden_permission", "missing_required_permission"]'::jsonb
      ELSE false END
    AND audit_metadata = pg_catalog.jsonb_build_object(
      'requestId', audit_metadata->>'requestId', 'source', 'api')
    AND pg_catalog.length(audit_metadata->>'requestId') > 0
    AND audit_key = 'staff.permission_override.rejected:' || (audit_metadata->>'requestId')
    AND pg_catalog.length(correlation_id) > 0
  );
END $$;
ALTER POLICY hotel_setup_reader_audit_update_denial ON platform.product_audit_events
USING (session_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader')
  AND current_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader'));
ALTER POLICY hotel_setup_reader_audit_delete_denial ON platform.product_audit_events
USING (session_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader')
  AND current_user NOT IN ('vayada_next_hotel_setup_reader', 'vayada_next_hotel_setup_creation_reader'));
