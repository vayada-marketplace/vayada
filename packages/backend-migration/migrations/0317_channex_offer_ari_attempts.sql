-- VAY-1545: inert initial rate/restriction ownership; no sender or activation grant.
CREATE TABLE pms.channex_offer_ari_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creation_attempt_id UUID NOT NULL REFERENCES pms.channex_offer_create_attempts(id),
  target_id UUID NOT NULL,
  intent_id UUID NOT NULL,
  version BIGINT NOT NULL,
  binding_generation UUID NOT NULL,
  external_property_id TEXT NOT NULL,
  external_room_type_id TEXT NOT NULL,
  external_rate_plan_id TEXT NOT NULL,
  job_attempt_id UUID NOT NULL REFERENCES platform.job_attempts(id),
  worker_id TEXT NOT NULL CHECK (worker_id <> '' AND worker_id=btrim(worker_id)),
  service_date DATE NOT NULL CHECK (isfinite(service_date)),
  request_body JSONB NOT NULL CHECK (
    jsonb_typeof(request_body)='object' AND request_body<>'{}'::jsonb AND
    octet_length(request_body::text)<=65536),
  state TEXT NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved','reconciled','released')),
  reconciliation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(reconciliation_evidence)='object' AND
    octet_length(reconciliation_evidence::text)<=8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('unresolved','released') AND reconciliation_evidence='{}'::jsonb) OR
         (state='reconciled' AND reconciliation_evidence<>'{}'::jsonb)),
  FOREIGN KEY(target_id,version,intent_id)
    REFERENCES pms.channex_offer_target_intents(target_id,version,id)
);
-- The provider resource, not a local connection generation, owns in-flight exclusion.
CREATE UNIQUE INDEX channex_offer_one_unresolved_ari
  ON pms.channex_offer_ari_attempts(external_property_id,external_rate_plan_id)
  WHERE state='unresolved';

CREATE FUNCTION pms.guard_channex_offer_ari_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE creation pms.channex_offer_create_attempts%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'ARI attempt history retained' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    -- Serialize terminalization with receipt capture, which locks the same target first.
    PERFORM 1 FROM pms.channex_offer_targets WHERE id=NEW.target_id FOR UPDATE;
    IF (to_jsonb(NEW)-'state'-'reconciliation_evidence') IS DISTINCT FROM
       (to_jsonb(OLD)-'state'-'reconciliation_evidence') OR
       OLD.state<>'unresolved' OR NEW.state NOT IN ('reconciled','released') THEN
      RAISE EXCEPTION 'ARI attempt identity and terminal state retained' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Same target-before-attempt order as current authority and receipt capture.
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
  -- Never accept caller-supplied provider identity or target/version overrides.
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
CREATE TRIGGER channex_offer_ari_attempt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_ari_attempts FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_offer_ari_attempt();
