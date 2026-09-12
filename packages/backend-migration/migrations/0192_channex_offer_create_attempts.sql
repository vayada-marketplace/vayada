-- VAY-1994: durable uncertainty only; no HTTP or activation authorization.
CREATE TABLE pms.channex_offer_create_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL UNIQUE,
  target_id UUID NOT NULL,
  version BIGINT NOT NULL,
  binding_generation UUID NOT NULL,
  external_property_id TEXT NOT NULL CHECK (external_property_id <> '' AND external_property_id = btrim(external_property_id)),
  external_room_type_id TEXT NOT NULL CHECK (external_room_type_id <> '' AND external_room_type_id = btrim(external_room_type_id)),
  request_body JSONB NOT NULL CHECK (jsonb_typeof(request_body) = 'object' AND request_body <> '{}'::jsonb),
  state TEXT NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved','identified')),
  external_rate_plan_id TEXT CHECK (external_rate_plan_id <> '' AND external_rate_plan_id = btrim(external_rate_plan_id)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='unresolved' AND external_rate_plan_id IS NULL) OR
         (state='identified' AND external_rate_plan_id IS NOT NULL)),
  FOREIGN KEY(target_id,version,intent_id) REFERENCES pms.channex_offer_target_intents(target_id,version,id)
);
-- A failed/replaced intent must not permit a duplicate after an uncertain create.
CREATE UNIQUE INDEX channex_offer_one_unresolved_create
  ON pms.channex_offer_create_attempts(target_id) WHERE state='unresolved';

CREATE FUNCTION pms.guard_channex_offer_create_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE connection UUID;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Channex creation history retained' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    -- Match the target-before-intent lock order used by version allocation.
    PERFORM 1 FROM pms.channex_offer_targets WHERE id=NEW.target_id FOR UPDATE;
    PERFORM 1 FROM pms.channex_offer_target_intents
      WHERE id=NEW.intent_id AND target_id=NEW.target_id AND version=NEW.version AND status='pending'
      FOR UPDATE;
    IF NOT FOUND OR NEW.state <> 'unresolved' OR NEW.external_rate_plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'Pending intent and unresolved creation required' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.intent_id,NEW.target_id,NEW.version,NEW.binding_generation,
        NEW.external_property_id,NEW.external_room_type_id,NEW.request_body,NEW.created_at)
      IS DISTINCT FROM
       (OLD.id,OLD.intent_id,OLD.target_id,OLD.version,OLD.binding_generation,
        OLD.external_property_id,OLD.external_room_type_id,OLD.request_body,OLD.created_at)
      OR OLD.state <> 'unresolved' OR NEW.state <> 'identified' OR NEW.external_rate_plan_id IS NULL THEN
      RAISE EXCEPTION 'Channex creation identity and terminal state retained' USING ERRCODE='23514';
    END IF;
    SELECT connection_id INTO STRICT connection FROM pms.channex_offer_targets WHERE id=NEW.target_id;
    PERFORM pms.claim_channex_external_rate(connection,NEW.external_rate_plan_id,'offer',NEW.target_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_create_attempt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_create_attempts FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_offer_create_attempt();
