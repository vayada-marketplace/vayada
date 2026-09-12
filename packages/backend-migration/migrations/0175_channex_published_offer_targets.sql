-- VAY-1973: storage only; no provider writes or activation authority.
CREATE TABLE pms.channex_offer_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  offer_id TEXT NOT NULL CHECK (offer_id <> '' AND offer_id = btrim(offer_id)),
  next_version BIGINT NOT NULL DEFAULT 1 CHECK (next_version > 0),
  active_version BIGINT,
  UNIQUE(connection_id, room_type_id, offer_id),
  FOREIGN KEY(connection_id, property_id) REFERENCES pms.channel_connections(id, property_id),
  FOREIGN KEY(room_type_id, property_id) REFERENCES pms.room_types(id, property_id)
);

CREATE TABLE pms.channex_offer_target_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID NOT NULL REFERENCES pms.channex_offer_targets(id),
  version BIGINT NOT NULL CHECK (version > 0),
  operation_key TEXT NOT NULL CHECK (operation_key <> '' AND operation_key = btrim(operation_key)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sealed','failed')),
  proposal JSONB NOT NULL CHECK (jsonb_typeof(proposal) = 'object' AND proposal <> '{}'::jsonb),
  result_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_evidence) = 'object'),
  UNIQUE(target_id, operation_key),
  UNIQUE(target_id, version),
  UNIQUE(target_id, version, id)
);
CREATE UNIQUE INDEX channex_offer_one_pending ON pms.channex_offer_target_intents(target_id) WHERE status='pending';

CREATE TABLE pms.channex_offer_target_versions (
  target_id UUID NOT NULL,
  version BIGINT NOT NULL,
  intent_id UUID NOT NULL UNIQUE,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  external_property_id TEXT NOT NULL CHECK (external_property_id <> '' AND external_property_id = btrim(external_property_id)),
  external_room_type_id TEXT NOT NULL CHECK (external_room_type_id <> '' AND external_room_type_id = btrim(external_room_type_id)),
  external_rate_plan_id TEXT NOT NULL CHECK (external_rate_plan_id <> '' AND external_rate_plan_id = btrim(external_rate_plan_id)),
  configuration JSONB NOT NULL CHECK (jsonb_typeof(configuration) = 'object' AND configuration <> '{}'::jsonb),
  readback_evidence JSONB NOT NULL CHECK (jsonb_typeof(readback_evidence) = 'object' AND readback_evidence <> '{}'::jsonb),
  PRIMARY KEY(target_id, version),
  FOREIGN KEY(target_id, version, intent_id) REFERENCES pms.channex_offer_target_intents(target_id, version, id)
);
ALTER TABLE pms.channex_offer_targets ADD FOREIGN KEY(id, active_version)
  REFERENCES pms.channex_offer_target_versions(target_id, version);

-- One shared ownership registry, including retained legacy identities. No implicit transfer.
CREATE TABLE pms.channex_external_rate_owners (
  connection_id UUID NOT NULL REFERENCES pms.channel_connections(id),
  external_rate_plan_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('legacy','offer')),
  owner_id UUID NOT NULL,
  legacy_identity JSONB,
  PRIMARY KEY(connection_id, external_rate_plan_id)
);
-- Block legacy writes until both backfill and trigger installation commit.
LOCK TABLE pms.channel_rate_plan_mappings IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO pms.channex_external_rate_owners
  SELECT connection_id, external_rate_plan_id, 'legacy', id,
    jsonb_build_array(property_id,room_type_id,rate_plan_id,channel)
  FROM pms.channel_rate_plan_mappings;

CREATE FUNCTION pms.claim_channex_external_rate(connection UUID, external_id TEXT, kind TEXT, owner UUID, identity JSONB DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pms.channex_external_rate_owners VALUES(connection, external_id, kind, owner, identity)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM pms.channex_external_rate_owners
    WHERE connection_id=connection AND external_rate_plan_id=external_id AND owner_kind=kind AND owner_id=owner
      AND legacy_identity IS NOT DISTINCT FROM identity) THEN
    RAISE EXCEPTION 'Channex external rate already owned' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION pms.retain_channex_mapping_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Channex mapping history is immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER channex_external_owner_retained BEFORE UPDATE OR DELETE ON pms.channex_external_rate_owners
  FOR EACH ROW EXECUTE FUNCTION pms.retain_channex_mapping_history();
CREATE TRIGGER channex_offer_version_retained BEFORE UPDATE OR DELETE ON pms.channex_offer_target_versions
  FOR EACH ROW EXECUTE FUNCTION pms.retain_channex_mapping_history();

CREATE FUNCTION pms.claim_legacy_channex_external_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.property_id,NEW.connection_id,NEW.room_type_id,NEW.rate_plan_id,NEW.channel)
    IS DISTINCT FROM (OLD.id,OLD.property_id,OLD.connection_id,OLD.room_type_id,OLD.rate_plan_id,OLD.channel) THEN
    RAISE EXCEPTION 'Legacy rate ownership transfer requires explicit repair' USING ERRCODE='23514';
  END IF;
  PERFORM pms.claim_channex_external_rate(NEW.connection_id, NEW.external_rate_plan_id, 'legacy', NEW.id,
    jsonb_build_array(NEW.property_id,NEW.room_type_id,NEW.rate_plan_id,NEW.channel));
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_legacy_external_owner AFTER INSERT OR UPDATE ON pms.channel_rate_plan_mappings
  FOR EACH ROW EXECUTE FUNCTION pms.claim_legacy_channex_external_rate();

CREATE FUNCTION pms.guard_channex_offer_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Channex target identity retained' USING ERRCODE='23514'; END IF;
  IF (NEW.id,NEW.property_id,NEW.connection_id,NEW.room_type_id,NEW.offer_id)
    IS DISTINCT FROM (OLD.id,OLD.property_id,OLD.connection_id,OLD.room_type_id,OLD.offer_id)
    OR NEW.next_version < OLD.next_version THEN
    RAISE EXCEPTION 'Channex target identity or sequence changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_target_guard BEFORE UPDATE OR DELETE ON pms.channex_offer_targets
  FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_offer_target();

CREATE FUNCTION pms.guard_channex_offer_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Channex intent retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'Intent must start pending' USING ERRCODE='23514'; END IF;
    UPDATE pms.channex_offer_targets SET next_version=next_version+1 WHERE id=NEW.target_id
      RETURNING next_version-1 INTO NEW.version;
  ELSIF (NEW.id,NEW.target_id,NEW.version,NEW.operation_key,NEW.proposal)
      IS DISTINCT FROM (OLD.id,OLD.target_id,OLD.version,OLD.operation_key,OLD.proposal)
      OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Channex intent identity or terminal state changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_intent_guard BEFORE INSERT OR UPDATE OR DELETE ON pms.channex_offer_target_intents
  FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_offer_intent();

CREATE FUNCTION pms.seal_channex_offer_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE connection UUID;
BEGIN
  UPDATE pms.channex_offer_target_intents SET status='sealed'
    WHERE id=NEW.intent_id AND target_id=NEW.target_id AND version=NEW.version AND status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Pending intent required' USING ERRCODE='23514'; END IF;
  SELECT connection_id INTO STRICT connection FROM pms.channex_offer_targets WHERE id=NEW.target_id;
  PERFORM pms.claim_channex_external_rate(connection,NEW.external_rate_plan_id,'offer',NEW.target_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_version_seal BEFORE INSERT ON pms.channex_offer_target_versions
  FOR EACH ROW EXECUTE FUNCTION pms.seal_channex_offer_version();

CREATE FUNCTION pms.check_channex_intent_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT; present BOOLEAN;
BEGIN
  SELECT status INTO state FROM pms.channex_offer_target_intents WHERE id=NEW.id;
  SELECT EXISTS(SELECT 1 FROM pms.channex_offer_target_versions WHERE intent_id=NEW.id) INTO present;
  IF (state='sealed') <> present THEN
    RAISE EXCEPTION 'Intent seal and version must agree' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER channex_intent_seal_complete AFTER INSERT OR UPDATE ON pms.channex_offer_target_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pms.check_channex_intent_seal();
