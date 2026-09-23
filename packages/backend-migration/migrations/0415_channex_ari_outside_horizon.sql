-- VAY-2036: retain successful provider tasks that fall outside the supported initial ARI window.
ALTER TABLE pms.channex_offer_ari_attempts
  DROP CONSTRAINT channex_offer_ari_attempts_state_check,
  DROP CONSTRAINT channex_offer_ari_attempts_check,
  ADD CONSTRAINT channex_offer_ari_attempts_state_check
    CHECK (state IN ('unresolved','reconciled','released','outside_horizon')),
  ADD CONSTRAINT channex_offer_ari_attempts_state_evidence_check CHECK (
    (state IN ('unresolved','released') AND reconciliation_evidence='{}'::jsonb) OR
    (state IN ('reconciled','outside_horizon') AND reconciliation_evidence<>'{}'::jsonb));

CREATE OR REPLACE FUNCTION pms.guard_channex_offer_ari_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creation pms.channex_offer_create_attempts%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'ARI attempt history retained' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    PERFORM 1 FROM pms.channex_offer_targets WHERE id=NEW.target_id FOR UPDATE;
    IF (to_jsonb(NEW)-'state'-'reconciliation_evidence') IS DISTINCT FROM
       (to_jsonb(OLD)-'state'-'reconciliation_evidence') OR
       OLD.state<>'unresolved' OR NEW.state NOT IN ('reconciled','released','outside_horizon') THEN
      RAISE EXCEPTION 'ARI attempt identity and terminal state retained' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM pms.channex_offer_targets t
    JOIN pms.channex_offer_create_attempts a ON a.target_id=t.id
    WHERE a.id=NEW.creation_attempt_id FOR UPDATE OF t;
  SELECT * INTO creation FROM pms.channex_offer_create_attempts
    WHERE id=NEW.creation_attempt_id FOR SHARE;
  IF NOT FOUND OR creation.state<>'identified' OR NEW.state<>'unresolved' THEN
    RAISE EXCEPTION 'Identified creation and unresolved ARI required' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM pms.channex_offer_target_intents i
    JOIN pms.channex_offer_targets t ON t.id=i.target_id
    JOIN pms.channel_connections c ON c.id=t.connection_id
    JOIN platform.jobs j ON j.property_id=t.property_id
    JOIN platform.job_attempts a ON a.job_id=j.id
    WHERE i.id=creation.intent_id AND i.status='pending'
      AND c.binding_generation=creation.binding_generation
      AND a.id=NEW.job_attempt_id AND a.worker_id=NEW.worker_id
    FOR SHARE OF i,c,j,a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending ARI binding or job correlation mismatch' USING ERRCODE='23514';
  END IF;
  NEW.target_id := creation.target_id;
  NEW.intent_id := creation.intent_id;
  NEW.version := creation.version;
  NEW.binding_generation := creation.binding_generation;
  NEW.external_property_id := creation.external_property_id;
  NEW.external_room_type_id := creation.external_room_type_id;
  NEW.external_rate_plan_id := creation.external_rate_plan_id;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
