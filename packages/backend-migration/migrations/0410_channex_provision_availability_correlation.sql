-- VAY-2036: admit room-correlated published-offer provisioning to availability dispatch.
CREATE OR REPLACE FUNCTION pms.guard_channex_room_availability_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
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
     AND COALESCE(j.payload->'restrictionsOnly','false'::jsonb)='false'::jsonb
     AND (
       (j.job_type='channex.sync_ari' AND j.payload->>'operationType'='sync_ari') OR
       (j.job_type='channex.provision' AND j.payload->>'operationType'='provision'
         AND lower(j.payload->'publishedOffer'->>'roomTypeId')=m.room_type_id::text)
     )
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
