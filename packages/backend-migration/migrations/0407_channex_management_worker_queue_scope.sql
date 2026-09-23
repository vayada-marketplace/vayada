-- VAY-2041: shared-queue foundation only. No roles, grants or enabled properties.
-- The complete PMS/source grant inventory and role preflight are separate gates.
CREATE TABLE platform.channex_management_worker_properties (
  property_id uuid PRIMARY KEY REFERENCES hotel_catalog.properties(id) ON DELETE RESTRICT
);
COMMENT ON TABLE platform.channex_management_worker_properties IS
  'Owner-managed Channex management scope; empty until reviewed provisioning.';

-- Existing callers must not need grants on worker-only lookup tables. This
-- invoker helper returns before querying them for every other current_user.
CREATE FUNCTION platform.channex_management_worker_scope(kind text, resource text, parent uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_properties WHERE property_id::text = resource);
    WHEN 'job' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE id::text = resource AND (parent IS NULL OR property_id = parent));
    WHEN 'management_key' THEN RETURN EXISTS (
      SELECT 1 FROM platform.jobs WHERE idempotency_key_hash = resource AND property_id = parent);
    WHEN 'attempt' THEN RETURN EXISTS (
      SELECT 1 FROM platform.job_attempts WHERE id::text = resource AND job_id = parent);
    ELSE RETURN false;
  END CASE;
END;
$$;

-- Existing identity policies remain the only permissive policies on these
-- shared tables. Restrictive policies cannot widen another role's access.
CREATE POLICY channex_management_worker_scope ON platform.jobs AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_scope('property', property_id::text)
    AND queue_name = 'pms.channex.management'
    AND resource_product = 'pms' AND resource_type = 'channex_connection'
    AND resource_id = property_id::text
    AND NOT (payload ?| ARRAY['recoveryAlertId','mealRatePlanId','markups','inventoryRules','restrictions'])
    AND ((job_type = 'channex.sync_ari' AND payload->>'operationType' = 'sync_ari')
      OR (job_type = 'channex.provision' AND payload->>'operationType' = 'provision'
        AND jsonb_typeof(payload->'publishedOffer') = 'object'))
  ));

-- Finance 0406 may already have enabled RLS with its own compatibility policy.
-- Add a permissive compatibility policy only when this table had no RLS.
DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='platform.job_attempts'::regclass) THEN
    ALTER TABLE platform.job_attempts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY channex_management_worker_compat ON platform.job_attempts TO PUBLIC USING (true);
  END IF;
END $$;
CREATE POLICY channex_management_worker_scope ON platform.job_attempts AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR platform.channex_management_worker_scope('job', job_id::text));

CREATE POLICY channex_management_worker_scope ON platform.dead_letter_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_scope('property', property_id::text)
    AND source_kind = 'job' AND resource_product = 'pms'
    AND resource_type = 'channex_connection' AND resource_id = property_id::text
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
    AND (job_attempt_id IS NULL OR platform.channex_management_worker_scope('attempt', job_attempt_id::text, job_id))
    AND (requeued_job_id IS NULL OR requeued_job_id = job_id)
  ));

CREATE POLICY channex_management_worker_scope ON platform.idempotency_keys AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_scope('property', property_id::text)
    AND operation_scope = 'pms' AND operation = 'channex_management'
    AND platform.channex_management_worker_scope('management_key', key_hash, property_id)
  ));

CREATE POLICY channex_management_worker_scope ON platform.product_audit_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_scope('property', property_id::text)
    AND product = 'pms' AND actor_type = 'system'
    AND target_resource_product = 'pms' AND target_resource_type = 'channex_connection'
    AND target_resource_id = property_id::text
    AND action IN ('pms.channex.provision.succeeded', 'pms.channex.provision.failed',
      'pms.channex.sync_ari.succeeded', 'pms.channex.sync_ari.failed')
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
  ));

-- The identity dead-letter policy references these receipt columns. A later
-- column SELECT grant permits policy evaluation but exposes no receipt rows.
CREATE POLICY channex_management_worker_scope ON platform.external_webhook_events AS RESTRICTIVE TO PUBLIC
  USING (current_user <> 'vayada_next_channex_management_worker');
