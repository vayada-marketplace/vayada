-- VAY-2055: admit Channex `enable` (connection) jobs for hotels without a binding.
-- Scope is the operation type plus a live enable job, not a property allowlist.
-- No roles, grants or admitted operations; the owner admits 'enable' at rollout.
CREATE TABLE platform.channex_management_worker_operations (
  operation_type text PRIMARY KEY CHECK (operation_type = 'enable')
);
COMMENT ON TABLE platform.channex_management_worker_operations IS
  'Owner-managed Channex management operation scope; empty until reviewed provisioning.';

-- A separate helper keeps platform.channex_management_worker_scope byte-identical:
-- hotel-setup provisioning pins that body. Like it, this returns before touching
-- worker-only tables for every other current_user and keeps PUBLIC execution, so
-- no existing policy consumer needs a new grant. 'property' admits a property
-- while an admitted enable job for it is pending or running. It reads
-- platform.jobs under the worker's own policy, so that policy must never call it.
CREATE FUNCTION platform.channex_management_worker_connection_scope(kind text, resource text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' THEN RETURN true; END IF;
  CASE kind
    WHEN 'operation' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_operations WHERE operation_type = resource);
    WHEN 'property' THEN RETURN EXISTS (
      SELECT 1 FROM platform.channex_management_worker_properties WHERE property_id::text = resource)
      OR EXISTS (
      SELECT 1 FROM platform.jobs WHERE property_id::text = resource AND queue_name = 'pms.channex.management'
        AND job_type = 'channex.enable' AND payload->>'operationType' = 'enable'
        AND status IN ('pending', 'running'));
    ELSE RETURN false;
  END CASE;
END;
$$;

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
      OR (platform.channex_management_worker_connection_scope('operation', 'enable')
        AND job_type = 'channex.enable' AND payload->>'operationType' = 'enable'))
  ));

-- Enable jobs are enqueued by the API on behalf of an operator; the worker
-- processes them but may never create one.
CREATE POLICY channex_management_worker_insert ON platform.jobs AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker' OR job_type <> 'channex.enable');

ALTER POLICY channex_management_worker_scope ON platform.dead_letter_events
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_connection_scope('property', property_id::text)
    AND source_kind = 'job' AND resource_product = 'pms'
    AND resource_type = 'channex_connection' AND resource_id = property_id::text
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
    AND (job_attempt_id IS NULL OR platform.channex_management_worker_scope('attempt', job_attempt_id::text, job_id))
    AND (requeued_job_id IS NULL OR requeued_job_id = job_id)
  ));

ALTER POLICY channex_management_worker_scope ON platform.idempotency_keys
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_connection_scope('property', property_id::text)
    AND operation_scope = 'pms' AND operation = 'channex_management'
    AND platform.channex_management_worker_scope('management_key', key_hash, property_id)
  ));

ALTER POLICY channex_management_worker_scope ON platform.product_audit_events
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND platform.channex_management_worker_connection_scope('property', property_id::text)
    AND product = 'pms' AND actor_type = 'system'
    AND target_resource_product = 'pms' AND target_resource_type = 'channex_connection'
    AND target_resource_id = property_id::text
    AND action IN ('pms.channex.provision.succeeded', 'pms.channex.provision.failed',
      'pms.channex.sync_ari.succeeded', 'pms.channex.sync_ari.failed',
      'pms.channex.enable.succeeded', 'pms.channex.enable.failed')
    AND platform.channex_management_worker_scope('job', job_id::text, property_id)
  ));

-- Only the sources an enable job reads follow the connection scope. Pricing,
-- inventory, finance and identity sources stay on the canary allowlist.
ALTER POLICY channex_management_worker_scope ON hotel_catalog.properties
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR platform.channex_management_worker_connection_scope('property', id::text));
ALTER POLICY channex_management_worker_scope ON hotel_catalog.property_locations
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR platform.channex_management_worker_connection_scope('property', property_id::text));
ALTER POLICY channex_management_worker_scope ON pms.room_types
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR platform.channex_management_worker_connection_scope('property', property_id::text));
ALTER POLICY channex_management_worker_scope ON pms.channel_connections
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND platform.channex_management_worker_connection_scope('property', property_id::text)));
ALTER POLICY channex_management_worker_scope ON pms.channel_binding_claims
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND platform.channex_management_worker_connection_scope('property', property_id::text)));

-- The worker may create a binding, never retarget or release one. Existing
-- claims stay locked by the lock-only policy; new claims are active enable claims.
CREATE POLICY channex_management_worker_insert ON pms.channel_binding_claims AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND claim_state = 'active' AND claim_source = 'enable'));
-- A new connection row is only ever the connected result of that claim; the
-- binding-claim trigger requires the matching active claim.
CREATE POLICY channex_management_worker_insert ON pms.channel_connections AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND connection_status = 'connected' AND external_property_id IS NOT NULL
      AND messaging_app_installed = false AND connection_metadata = '{}'::jsonb));

-- Besides the legacy ARI timestamp, the worker may bind an unbound row once and
-- then record creation evidence for that same external property. Nothing else.
CREATE OR REPLACE FUNCTION pms.guard_channex_worker_connection_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD) - 'last_ari_sync_at' - 'updated_at';
  new_row jsonb := to_jsonb(NEW) - 'last_ari_sync_at' - 'updated_at';
BEGIN
  IF current_user <> 'vayada_next_channex_management_worker' OR new_row = old_row THEN RETURN NEW; END IF;
  IF OLD.external_property_id IS NULL AND OLD.connection_status <> 'connected'
    AND NEW.external_property_id IS NOT NULL AND NEW.connection_status = 'connected'
    AND (new_row - 'external_property_id' - 'connection_status') = (old_row - 'external_property_id' - 'connection_status')
    AND EXISTS (SELECT 1 FROM pms.channel_binding_claims claim
      WHERE claim.property_id = NEW.property_id AND claim.provider = 'channex'
        AND claim.external_property_id = NEW.external_property_id
        AND claim.claim_state = 'active' AND claim.claim_source = 'enable')
  THEN RETURN NEW; END IF;
  IF OLD.external_property_id IS NOT NULL AND NEW.external_property_id = OLD.external_property_id
    AND NEW.connection_status = 'connected'
    AND OLD.connection_metadata -> 'airbnbCreationEvidence' IS NULL
    AND jsonb_typeof(NEW.connection_metadata -> 'airbnbCreationEvidence') = 'object'
    AND (NEW.connection_metadata - 'airbnbCreationEvidence') = OLD.connection_metadata
    AND lower(NEW.connection_metadata -> 'airbnbCreationEvidence' ->> 'externalPropertyId') = lower(NEW.external_property_id)
    AND (new_row - 'connection_metadata') = (old_row - 'connection_metadata')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Channex worker connection identity is read only' USING ERRCODE='42501';
END;
$$;

-- Binding an unbound row rotates the generation but has no unresolved tombstones
-- to settle: those only exist for a bound generation and were resolved when the
-- binding was released. Skip that UPDATE so the connection worker needs no
-- tombstone privilege; the rotation itself is unchanged.
CREATE OR REPLACE FUNCTION pms.rotate_channel_connection_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.external_property_id IS DISTINCT FROM NEW.external_property_id THEN
    IF OLD.external_property_id IS NOT NULL THEN
      UPDATE pms.channel_booking_revision_tombstones
        SET resolved_at = COALESCE(resolved_at, now()), updated_at = now()
        WHERE connection_id = OLD.id AND binding_generation = OLD.binding_generation
          AND resolved_at IS NULL;
    END IF;
    NEW.binding_generation := gen_random_uuid();
  END IF;
  RETURN NEW;
END $$;
