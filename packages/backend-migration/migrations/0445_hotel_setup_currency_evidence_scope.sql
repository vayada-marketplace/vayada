-- VAY-1092: scope currency retry/event/audit rows to the native property's
-- currency operation. No login, grant, readiness transition or activation.
DO $$
DECLARE item RECORD;
DECLARE non_setup TEXT := $guard$
  session_user::text !~ '^vayada_next_hotel_setup_property_'
  AND current_user::text !~ '^vayada_next_hotel_setup_property_'
  AND NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
  AND NOT pg_catalog.pg_has_role(current_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
$guard$;
DECLARE currency_scope TEXT := $scope$
  tenant_scope = 'property' AND organization_id IS NULL
  AND platform.hotel_setup_property_row_allowed(property_id)
  AND (platform.hotel_setup_property_operation_allowed(property_id, 'currency')
    OR platform.hotel_setup_property_operation_allowed(property_id, 'currency_ready'))
$scope$;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('platform.idempotency_keys'::regclass, true, $key$
      operation_scope = 'pms' AND operation = 'pms.pricing_currency.upsert'
      AND response_resource_product IS NULL AND response_resource_type IS NULL
      AND response_resource_id IS NULL
    $key$),
    ('platform.domain_events'::regclass, false, $event$
      source_system = 'pms' AND event_type = 'pms.pricing_source.changed' AND event_version = 1
      AND resource_product = 'pms' AND resource_type = 'property_pricing'
      AND resource_id = property_id::text AND actor_type = 'user'
      AND EXISTS (SELECT 1 FROM identity.organization_memberships m
        WHERE m.user_id = actor_user_id AND m.status = 'active'
          AND m.organization_id = platform.hotel_setup_property_assigned_organization())
      AND payload->>'propertyId' = property_id::text
      AND payload->>'outcome' IN ('currency_created', 'currency_updated')
      AND payload->'flexibleRatePlanId' = 'null'::jsonb
      AND payload->'flexibleRatePlanRevision' = 'null'::jsonb
    $event$),
    ('platform.outbox_events'::regclass, false, $outbox$
      destination IN ('booking.pricing-source', 'finance.pricing-source')
      AND event_type = 'pms.pricing_source.changed'
      AND resource_product = 'pms' AND resource_type = 'property_pricing'
      AND resource_id = property_id::text
      AND EXISTS (SELECT 1 FROM platform.domain_events e
        WHERE e.id = outbox_events.domain_event_id AND e.property_id = outbox_events.property_id
          AND e.payload = outbox_events.payload AND e.idempotency_key_hash = outbox_events.idempotency_key_hash)
    $outbox$),
    ('platform.product_audit_events'::regclass, false, $audit$
      product = 'pms' AND action = 'pms.pricing_currency.upsert'
      AND target_resource_product = 'pms' AND target_resource_type = 'property_pricing'
      AND target_resource_id = property_id::text AND actor_type = 'user'
      AND EXISTS (SELECT 1 FROM identity.organization_memberships m
        WHERE m.user_id = actor_user_id AND m.status = 'active'
          AND m.organization_id = platform.hotel_setup_property_assigned_organization())
      AND secondary_resource_product IS NULL AND secondary_resource_type IS NULL
      AND secondary_resource_id IS NULL AND job_id IS NULL AND external_webhook_event_id IS NULL
      AND private_payload = '{}'::jsonb AND redacted_payload->>'propertyId' = property_id::text
      AND audit_metadata->>'actorOrganizationId' = platform.hotel_setup_property_assigned_organization()::text
      AND EXISTS (SELECT 1 FROM platform.idempotency_keys k
        WHERE k.id = product_audit_events.idempotency_key_id AND k.property_id = product_audit_events.property_id)
      AND (domain_event_id IS NULL OR EXISTS (SELECT 1 FROM platform.domain_events e
        WHERE e.id = product_audit_events.domain_event_id AND e.property_id = product_audit_events.property_id
          AND e.actor_user_id = product_audit_events.actor_user_id))
    $audit$)
  ) AS evidence(relation, update_allowed, predicate) LOOP
    -- Preserve existing ACL-backed callers when enabling RLS for the first time.
    -- Do not add a permissive policy to already-scoped Identity/worker tables.
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = item.relation) THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', item.relation);
      EXECUTE format('CREATE POLICY hotel_setup_currency_existing_callers ON %s
        TO PUBLIC USING (true) WITH CHECK (true)', item.relation);
    END IF;
    EXECUTE format('CREATE POLICY hotel_setup_currency_evidence_guard ON %s
      AS RESTRICTIVE TO PUBLIC USING ((%s) OR (current_user = session_user
        AND pg_catalog.pg_has_role(session_user, ''vayada_next_hotel_setup_property_scope'', ''USAGE'')))',
      item.relation, non_setup);
    EXECUTE format('CREATE POLICY hotel_setup_currency_evidence_scope ON %s
      AS RESTRICTIVE TO vayada_next_hotel_setup_property_scope
      USING ((%s) AND (%s)) WITH CHECK ((%s) AND (%s))',
      item.relation, currency_scope, item.predicate, currency_scope, item.predicate);
    EXECUTE format('CREATE POLICY hotel_setup_currency_evidence_delete_denial ON %s
      AS RESTRICTIVE FOR DELETE TO PUBLIC USING (%s)', item.relation, non_setup);
    IF NOT item.update_allowed THEN
      EXECUTE format('CREATE POLICY hotel_setup_currency_evidence_update_denial ON %s
        AS RESTRICTIVE FOR UPDATE TO PUBLIC USING (%s) WITH CHECK (%s)',
        item.relation, non_setup, non_setup);
    END IF;
  END LOOP;
END $$;
