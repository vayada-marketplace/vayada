-- VAY-1545: immutable original observations for room-availability dispatches.
CREATE TABLE pms.channex_room_availability_receipts (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL UNIQUE,
  job_attempt_id UUID NOT NULL,
  worker_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('complete_json','invalid_json','body_limit','body_interrupted','transport_error')),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  provider_request_id TEXT CHECK (
    length(provider_request_id) BETWEEN 1 AND 512 AND
    provider_request_id ~ '^[A-Za-z0-9._:-]+$'),
  task_ids UUID[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(task_ids)<=100 AND array_position(task_ids,NULL) IS NULL),
  has_warnings BOOLEAN NOT NULL,
  warning_reason TEXT,
  CHECK (outcome='complete_json' OR (cardinality(task_ids)=0 AND has_warnings)),
  CHECK ((outcome='transport_error' AND http_status IS NULL AND provider_request_id IS NULL) OR
         (outcome<>'transport_error' AND http_status IS NOT NULL)),
  CHECK (
    (outcome='complete_json' AND has_warnings AND warning_reason IS NOT NULL AND warning_reason IN (
      'invalid_tasks','root_errors','root_warnings','invalid_meta',
      'invalid_warnings','provider_warnings')) OR
    (outcome='complete_json' AND NOT has_warnings AND warning_reason IS NULL AND
      cardinality(task_ids)>0) OR
    (outcome<>'complete_json' AND has_warnings AND warning_reason IS NULL)),
  FOREIGN KEY(attempt_id,job_attempt_id,worker_id)
    REFERENCES pms.channex_room_availability_attempts(id,job_attempt_id,worker_id)
);

CREATE FUNCTION pms.guard_channex_room_availability_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Room availability receipts are retained and immutable' USING ERRCODE='23514';
  END IF;
  NEW.captured_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER channex_room_availability_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pms.channex_room_availability_receipts
  FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_room_availability_receipt();
