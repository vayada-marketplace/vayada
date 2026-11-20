-- VAY-2108: the ongoing offer ARI delivery guard no longer locks the active target version FOR SHARE.
-- FOR SHARE needs UPDATE on pms.channex_offer_target_versions, and the Channex worker login has only
-- SELECT and INSERT there, so the first production delivery after Tiga Lombok's activation
-- (2026-11-20 00:46Z) failed on every insert with 42501. The row cannot change after insert
-- (0314's channex_offer_version_retained refuses UPDATE and DELETE), and the target row is still
-- locked FOR UPDATE first, so the lock added nothing. Everything else is byte-identical to 0520.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pms.guard_channex_offer_ari_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target pms.channex_offer_targets%ROWTYPE; active pms.channex_offer_target_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Offer ARI delivery history retained' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM 1 FROM pms.channex_offer_targets WHERE id = NEW.target_id FOR UPDATE;
    IF (to_jsonb(NEW) - 'state' - 'reconciliation_evidence') IS DISTINCT FROM
       (to_jsonb(OLD) - 'state' - 'reconciliation_evidence') OR
       OLD.state <> 'unresolved' OR NEW.state NOT IN ('reconciled', 'released') THEN
      RAISE EXCEPTION 'Offer ARI delivery identity and terminal state retained' USING ERRCODE = '23514';
    END IF;
    -- Released means provably not sent: once Channex answered, only a readback may settle it.
    IF NEW.state = 'released' AND EXISTS (
      SELECT 1 FROM pms.channex_offer_ari_delivery_receipts WHERE delivery_id = NEW.id) THEN
      RAISE EXCEPTION 'A delivery with a provider receipt cannot be released' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Target before delivery, as in the initial ARI and receipt capture.
  SELECT * INTO target FROM pms.channex_offer_targets WHERE id = NEW.target_id FOR UPDATE;
  IF NOT FOUND OR target.active_version IS NULL OR NEW.state <> 'unresolved' THEN
    RAISE EXCEPTION 'Active offer target and unresolved delivery required' USING ERRCODE = '23514';
  END IF;
  -- Versions are immutable (0314's channex_offer_version_retained), so no row lock: FOR SHARE
  -- needs UPDATE, which the Channex worker has no grant for on this table (VAY-2108, 0543).
  SELECT * INTO active FROM pms.channex_offer_target_versions
    WHERE target_id = target.id AND version = target.active_version;
  IF EXISTS (SELECT 1 FROM pms.channex_offer_ari_attempts
    WHERE target_id = target.id AND state = 'unresolved') THEN
    RAISE EXCEPTION 'Initial offer ARI still unresolved' USING ERRCODE = '23514';
  END IF;
  -- The current lease of a running full ARI job on the connected binding (as 0320).
  PERFORM 1 FROM pms.channel_connections connection
    JOIN platform.jobs job ON job.property_id = connection.property_id
    JOIN platform.job_attempts attempt ON attempt.job_id = job.id
    WHERE connection.id = target.connection_id AND connection.provider = 'channex'
      AND connection.connection_status = 'connected'
      AND connection.binding_generation = active.binding_generation
      AND connection.external_property_id = active.external_property_id
      AND attempt.id = NEW.job_attempt_id AND attempt.worker_id = NEW.worker_id
      AND job.status = 'running' AND attempt.status = 'running'
      AND job.locked_by = NEW.worker_id AND job.attempts_count = attempt.attempt_number
      AND job.finished_at IS NULL AND attempt.finished_at IS NULL
      AND job.locked_at > clock_timestamp() - interval '5 minutes'
      AND job.locked_at <= clock_timestamp()
      AND job.queue_name = 'pms.channex.management' AND job.tenant_scope = 'property'
      AND job.resource_product = 'pms' AND job.resource_type = 'channex_connection'
      AND job.resource_id = job.property_id::text AND job.job_type = 'channex.sync_ari'
      AND job.payload->>'operationType' = 'sync_ari'
      AND COALESCE(job.payload->'restrictionsOnly', 'false'::jsonb) = 'false'::jsonb
    FOR SHARE OF connection, job, attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active binding or job correlation mismatch' USING ERRCODE = '23514';
  END IF;
  -- Never accept caller-supplied provider identity or version, and send only to that identity.
  NEW.version := active.version;
  NEW.binding_generation := active.binding_generation;
  NEW.external_property_id := active.external_property_id;
  NEW.external_room_type_id := active.external_room_type_id;
  NEW.external_rate_plan_id := active.external_rate_plan_id;
  NEW.created_at := clock_timestamp();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.request_body->'values') entry
    WHERE entry->>'property_id' IS DISTINCT FROM NEW.external_property_id
      OR entry->>'rate_plan_id' IS DISTINCT FROM NEW.external_rate_plan_id) THEN
    RAISE EXCEPTION 'Delivery values must target the active rate plan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
