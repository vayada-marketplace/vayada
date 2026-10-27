-- VAY-2108: the claimed Channex worker scope (engineering/channex-per-hotel-ownership.md).
-- The worker may run ARI and published-offer provisioning for hotels the target owns: an active
-- binding claim on the same external id as a connected (or degraded) connection. It is off until
-- the owner admits operations in the new table. The pinned worker_scope, worker_source and
-- connection_scope helpers stay byte-identical; every policy keeps its current branches.
SET LOCAL lock_timeout = '5s';

CREATE TABLE platform.channex_management_worker_claimed_operations (
  operation_type text PRIMARY KEY CHECK (operation_type IN ('sync_ari', 'provision'))
);
COMMENT ON TABLE platform.channex_management_worker_claimed_operations IS
  'Owner-managed claimed Channex operation scope; empty until reviewed provisioning.';
-- The VAY-2054 default privileges would let the API login widen the worker scope.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vayada_next_api_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON platform.channex_management_worker_claimed_operations FROM vayada_next_api_runtime;
  END IF;
END $$;

-- Like 0473's helper it returns true for every other current_user before reading worker tables,
-- so it keeps PUBLIC execution and no policy consumer needs a grant. 'operation(s)' read only the
-- new table, 'binding' only claims, 'property' claims and connections. Claims and connections
-- reach platform.jobs through connection_scope, so the jobs policy calls only 'operation'. Until
-- the claimed grant lets the worker read the new table it has no claimed scope, instead of
-- failing every scan. Resources are compared as uuids so the claim lookups can use indexes.
CREATE FUNCTION platform.channex_management_worker_claimed_scope(kind text, resource text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  IF kind <> 'binding' AND NOT has_table_privilege(
    'platform.channex_management_worker_claimed_operations', 'SELECT') THEN RETURN false; END IF;
  IF kind IN ('binding', 'property') AND (resource IS NULL OR resource !~ CASE kind
    WHEN 'property' THEN '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ELSE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' END) THEN
    RETURN false;
  END IF;
  CASE kind
    WHEN 'operation' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_claimed_operations WHERE operation_type = resource);
    WHEN 'operations' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_claimed_operations);
    WHEN 'binding' THEN RETURN EXISTS (
      SELECT 1 FROM pms.channel_binding_claims
      WHERE property_id = left(resource, 36)::uuid AND provider = 'channex'
        AND external_property_id = substr(resource, 38) AND claim_state = 'active');
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_claimed_operations)
      AND EXISTS (
      SELECT 1 FROM pms.channel_binding_claims claim
      JOIN pms.channel_connections connection ON connection.property_id = claim.property_id
        AND connection.provider = claim.provider
        AND connection.external_property_id = claim.external_property_id
      WHERE claim.property_id = resource::uuid AND claim.provider = 'channex'
        AND claim.claim_state = 'active' AND connection.connection_status IN ('connected', 'degraded'));
    ELSE RETURN false;
  END CASE;
END;
$$;

ALTER POLICY channex_management_worker_scope ON pms.channel_binding_claims
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND (platform.channex_management_worker_connection_scope('property', property_id::text)
      OR (claim_state = 'active' AND platform.channex_management_worker_claimed_scope('operations', '')))));
ALTER POLICY channex_management_worker_scope ON pms.channel_connections
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND (platform.channex_management_worker_connection_scope('property', property_id::text)
      OR (connection_status IN ('connected', 'degraded')
        AND platform.channex_management_worker_claimed_scope('operations', '')
        AND platform.channex_management_worker_claimed_scope('binding', property_id::text || '/' || external_property_id)))));
-- The claimed branch only reads and updates owned bindings. Creating a claim or a connection still
-- needs 0473's live enable job, or the worker could reserve any hotel's Channex property.
ALTER POLICY channex_management_worker_insert ON pms.channel_binding_claims
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND claim_state = 'active' AND claim_source = 'enable'
      AND platform.channex_management_worker_connection_scope('property', property_id::text)));
ALTER POLICY channex_management_worker_insert ON pms.channel_connections
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND connection_status = 'connected' AND external_property_id IS NOT NULL
      AND messaging_app_installed = false AND connection_metadata = '{}'::jsonb
      AND platform.channex_management_worker_connection_scope('property', property_id::text)));

-- Property-keyed sources: the 0408 canary branch (0473's connection branch for the three tables an
-- enable job reads) plus the claimed branch.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('hotel_catalog.properties','id','connection_scope'),
    ('hotel_catalog.property_locations','property_id','connection_scope'),
    ('pms.room_types','property_id','connection_scope'),
    ('finance.payment_settings','property_id','scope'),
    ('finance.payment_provider_accounts','property_id','scope'),
    ('finance.online_card_execution_evidence','property_id','scope'),
    ('booking.pricing_v2_offer_term_heads','property_id','scope'),
    ('booking.pricing_v2_offer_terms','property_id','scope'),
    ('booking.fixed_charge_heads','property_id','scope'),
    ('booking.fixed_charge_revisions','property_id','scope'),
    ('booking.same_day_booking_policies','property_id','scope'),
    ('pms.rooms','property_id','scope'),
    ('pms.room_type_closures','property_id','scope'),
    ('pms.property_pricing_settings','property_id','scope'),
    ('pms.rate_plans','property_id','scope'),
    ('pms.recurring_pricing_sources','property_id','scope'),
    ('pms.recurring_pricing_source_room_values','property_id','scope'),
    ('pms.channel_date_prices','property_id','scope'),
    ('pms.pricing_v2_heads','property_id','scope'),
    ('pms.pricing_v2_revisions','property_id','scope'),
    ('pms.pricing_v2_rooms','property_id','scope'),
    ('pms.pricing_v2_charge_declarations','property_id','scope'),
    ('pms.operating_calendar_revisions','property_id','scope'),
    ('pms.operating_calendar_recurring_periods','property_id','scope'),
    ('pms.operating_calendar_room_bindings','property_id','scope'),
    ('pms.inventory_days','property_id','scope'),
    ('pms.inventory_materialization_coverage','property_id','scope'),
    ('pms.channex_ari_schedule_sources','property_id','scope')
  ) AS scope(relation,property_column,helper) LOOP
    EXECUTE format('ALTER POLICY channex_management_worker_scope ON %s USING
      (current_user <> ''vayada_next_channex_management_worker''
        OR platform.channex_management_worker_%s(''property'',%I::text)
        OR platform.channex_management_worker_claimed_scope(''property'',%I::text))',
      item.relation, item.helper, item.property_column, item.property_column);
  END LOOP;
END $$;
ALTER POLICY channex_management_worker_scope ON identity.organization_resource_links
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR ((product, resource_type) IN (('hotel_catalog','property'),('pms','pms_property'))
      AND (platform.channex_management_worker_scope('property', resource_id)
        OR platform.channex_management_worker_claimed_scope('property', resource_id))));

-- Queue rows: the claimed branch admits the canary's two job shapes by admitted operation, like
-- 0473's enable branch, and never by property: reading claims or connections here would loop
-- through their connection_scope back into this policy. A job for a hotel the target does not own
-- stays inert, because every source, connection and evidence row it needs follows the claim.
ALTER POLICY channex_management_worker_scope ON platform.jobs
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND queue_name = 'pms.channex.management'
    AND resource_product = 'pms' AND resource_type = 'channex_connection'
    AND resource_id = property_id::text
    AND NOT (payload ?| ARRAY['recoveryAlertId','mealRatePlanId','markups','inventoryRules','restrictions'])
    AND ((platform.channex_management_worker_scope('property', property_id::text)
        AND ((job_type = 'channex.sync_ari' AND payload->>'operationType' = 'sync_ari')
          OR (job_type = 'channex.provision' AND payload->>'operationType' = 'provision'
            AND jsonb_typeof(payload->'publishedOffer') = 'object')))
      OR (job_type = 'channex.sync_ari' AND payload->>'operationType' = 'sync_ari'
        AND platform.channex_management_worker_claimed_scope('operation', 'sync_ari'))
      OR (job_type = 'channex.provision' AND payload->>'operationType' = 'provision'
        AND jsonb_typeof(payload->'publishedOffer') = 'object'
        AND platform.channex_management_worker_claimed_scope('operation', 'provision'))
      OR (platform.channex_management_worker_connection_scope('operation', 'enable')
        AND job_type = 'channex.enable' AND payload->>'operationType' = 'enable'))
  ));
ALTER POLICY channex_management_worker_scope ON platform.dead_letter_events
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND (platform.channex_management_worker_connection_scope('property', property_id::text)
      OR platform.channex_management_worker_claimed_scope('property', property_id::text))
    AND source_kind = 'job' AND resource_product = 'pms'
    AND resource_type = 'channex_connection' AND resource_id = property_id::text
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
    AND (job_attempt_id IS NULL OR platform.channex_management_worker_scope('attempt', job_attempt_id::text, job_id))
    AND (requeued_job_id IS NULL OR requeued_job_id = job_id)
  ));
ALTER POLICY channex_management_worker_scope ON platform.idempotency_keys
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND (platform.channex_management_worker_connection_scope('property', property_id::text)
      OR platform.channex_management_worker_claimed_scope('property', property_id::text))
    AND operation_scope = 'pms' AND operation = 'channex_management'
    AND platform.channex_management_worker_scope('management_key', key_hash, property_id)
  ));
ALTER POLICY channex_management_worker_scope ON platform.product_audit_events
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND (platform.channex_management_worker_connection_scope('property', property_id::text)
      OR platform.channex_management_worker_claimed_scope('property', property_id::text))
    AND product = 'pms' AND actor_type = 'system'
    AND target_resource_product = 'pms' AND target_resource_type = 'channex_connection'
    AND target_resource_id = property_id::text
    AND action IN ('pms.channex.provision.succeeded', 'pms.channex.provision.failed',
      'pms.channex.sync_ari.succeeded', 'pms.channex.sync_ari.failed',
      'pms.channex.enable.succeeded', 'pms.channex.enable.failed')
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
  ));

-- Restriction ARI follows ownership too: no job for a hotel without the active claim.
CREATE OR REPLACE FUNCTION pms.enqueue_restriction_ari(property UUID, source TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO platform.jobs(job_key,queue_name,job_type,property_id,tenant_scope,
    resource_product,resource_type,resource_id,payload,job_metadata,max_attempts)
  SELECT 'channex.ari:'||property||':'||source,'pms.channex.management','channex.sync_ari',
    property,'property','pms','channex_connection',property::text,
    jsonb_build_object('operationType','sync_ari','commandId',source,'idempotencyKey',source,
      'restrictionsOnly',TRUE),
    jsonb_build_object('source','canonical_restrictions'),5
  WHERE EXISTS (SELECT 1 FROM pms.channel_connections connection
    JOIN pms.channel_binding_claims claim ON claim.property_id = connection.property_id
      AND claim.provider = connection.provider
      AND claim.external_property_id = connection.external_property_id
      AND claim.claim_state = 'active'
    WHERE connection.property_id=property AND connection.provider='channex'
      AND connection.connection_status IN ('connected','degraded'))
  ON CONFLICT (queue_name,job_key) DO NOTHING;
$$;
