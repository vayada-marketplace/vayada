-- VAY-1545: original ARI observations never release unresolved upload ownership.
ALTER TABLE pms.channex_offer_ari_attempts
  ADD CONSTRAINT channex_ari_correlation_unique UNIQUE(id,job_attempt_id,worker_id);
CREATE TABLE pms.channex_offer_ari_receipts (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL,
  job_attempt_id UUID NOT NULL,
  worker_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('complete_json','invalid_json','body_limit','body_interrupted','transport_error')),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  provider_request_id TEXT CHECK (length(provider_request_id) BETWEEN 1 AND 512 AND provider_request_id ~ '^[A-Za-z0-9._:-]+$'),
  task_ids UUID[] NOT NULL DEFAULT '{}' CHECK (cardinality(task_ids)<=100 AND array_position(task_ids,NULL) IS NULL),
  has_warnings BOOLEAN NOT NULL,
  CHECK (outcome='complete_json' OR (cardinality(task_ids)=0 AND has_warnings)),
  CHECK ((outcome='transport_error' AND http_status IS NULL AND provider_request_id IS NULL) OR
         (outcome<>'transport_error' AND http_status IS NOT NULL)),
  FOREIGN KEY(attempt_id,job_attempt_id,worker_id)
    REFERENCES pms.channex_offer_ari_attempts(id,job_attempt_id,worker_id)
);
CREATE INDEX channex_ari_receipts_attempt ON pms.channex_offer_ari_receipts(attempt_id);
CREATE FUNCTION pms.guard_channex_ari_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'ARI receipts are retained and immutable' USING ERRCODE='23514';
  END IF;
  -- A real row update also fences stale REPEATABLE READ/SERIALIZABLE reconciliation.
  UPDATE pms.channex_offer_targets t SET next_version=t.next_version
    FROM pms.channex_offer_ari_attempts a WHERE a.id=NEW.attempt_id AND t.id=a.target_id;
  NEW.captured_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_ari_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_ari_receipts FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_ari_receipt();
