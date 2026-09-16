-- VAY-1545: inert room-scoped availability ownership; no sender or activation grant.
CREATE TABLE pms.channex_room_availability_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  mapping_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  binding_generation UUID NOT NULL,
  external_property_id TEXT NOT NULL,
  external_room_type_id TEXT NOT NULL,
  job_attempt_id UUID NOT NULL REFERENCES platform.job_attempts(id),
  worker_id TEXT NOT NULL CHECK (worker_id<>'' AND worker_id=btrim(worker_id)),
  service_date DATE NOT NULL CHECK (isfinite(service_date)),
  available_count INTEGER NOT NULL CHECK (available_count>=0),
  inventory_evidence JSONB NOT NULL CHECK (
    jsonb_typeof(inventory_evidence)='object' AND inventory_evidence<>'{}'::jsonb AND
    octet_length(inventory_evidence::text)<=32768),
  request_body JSONB NOT NULL CHECK (
    jsonb_typeof(request_body)='object' AND request_body<>'{}'::jsonb AND
    octet_length(request_body::text)<=16384),
  state TEXT NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved','reconciled','not_sent')),
  reconciliation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(reconciliation_evidence)='object' AND
    octet_length(reconciliation_evidence::text)<=8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='unresolved' AND reconciliation_evidence='{}'::jsonb) OR
         (state='reconciled' AND reconciliation_evidence<>'{}'::jsonb) OR
         (state='not_sent' AND reconciliation_evidence=
           '{"schemaVersion":1,"reason":"pre_dispatch_verification_unavailable"}'::jsonb)),
  UNIQUE(id,job_attempt_id,worker_id)
);

-- These are retained provider-write identities. The insert trigger derives all
-- local IDs while their rows are current; history must survive later room,
-- mapping, connection, or property retirement without adding delete blockers.

-- The provider room owns availability across dates, rate targets, and replacements.
CREATE UNIQUE INDEX channex_room_one_unresolved_availability
  ON pms.channex_room_availability_attempts(external_property_id,external_room_type_id)
  WHERE state='unresolved';

CREATE FUNCTION pms.guard_channex_room_availability_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope RECORD;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Room availability attempt history retained' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'state'-'reconciliation_evidence') IS DISTINCT FROM
       (to_jsonb(OLD)-'state'-'reconciliation_evidence') OR
       OLD.state<>'unresolved' OR NEW.state NOT IN ('reconciled','not_sent') THEN
      RAISE EXCEPTION 'Room availability identity and terminal state retained' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT m.property_id,m.connection_id,m.room_type_id,c.binding_generation,
         c.external_property_id,m.external_room_type_id
    INTO scope
    FROM pms.channel_room_type_mappings m
    JOIN pms.channel_connections c
      ON c.id=m.connection_id AND c.property_id=m.property_id
    JOIN pms.room_types r ON r.id=m.room_type_id AND r.property_id=m.property_id
    JOIN platform.job_attempts a ON a.id=NEW.job_attempt_id AND a.worker_id=NEW.worker_id
    JOIN platform.jobs j ON j.id=a.job_id AND j.property_id=m.property_id
   WHERE m.id=NEW.mapping_id AND m.status='active' AND r.active
     AND c.provider='channex' AND c.connection_status='connected'
     AND c.external_property_id IS NOT NULL AND c.external_property_id=btrim(c.external_property_id)
     AND c.external_property_id<>'' AND m.external_room_type_id=btrim(m.external_room_type_id)
     AND m.external_room_type_id<>''
     AND j.status='running' AND a.status='running'
     AND j.locked_by=NEW.worker_id AND j.attempts_count=a.attempt_number
     AND j.finished_at IS NULL AND a.finished_at IS NULL
     AND j.locked_at>clock_timestamp()-interval '5 minutes'
     AND j.locked_at<=clock_timestamp()
     AND j.queue_name='pms.channex.management' AND j.tenant_scope='property'
     AND j.resource_product='pms' AND j.resource_type='channex_connection'
     AND j.resource_id=j.property_id::text
     AND j.job_type='channex.sync_ari'
     AND j.payload->>'operationType'='sync_ari'
     AND COALESCE(j.payload->'restrictionsOnly','false'::jsonb)='false'::jsonb
   FOR SHARE OF m,c,r,j,a;
  IF NOT FOUND OR NEW.state<>'unresolved' THEN
    RAISE EXCEPTION 'Active room mapping and correlated sync job required' USING ERRCODE='23514';
  END IF;

  NEW.property_id := scope.property_id;
  NEW.connection_id := scope.connection_id;
  NEW.room_type_id := scope.room_type_id;
  NEW.binding_generation := scope.binding_generation;
  NEW.external_property_id := scope.external_property_id;
  NEW.external_room_type_id := scope.external_room_type_id;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER channex_room_availability_attempt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pms.channex_room_availability_attempts
  FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_room_availability_attempt();
