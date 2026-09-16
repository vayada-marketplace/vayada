-- VAY-2003: inert receipt storage; current authority and sanitization are service gates.
ALTER TABLE pms.channex_offer_create_attempts
  ADD COLUMN job_attempt_id UUID REFERENCES platform.job_attempts(id),
  ADD COLUMN worker_id TEXT,
  ADD CONSTRAINT channex_create_correlation_complete CHECK (
    (job_attempt_id IS NULL AND worker_id IS NULL) OR
    (job_attempt_id IS NOT NULL AND worker_id IS NOT NULL AND
     worker_id <> '' AND worker_id = btrim(worker_id))),
  ADD CONSTRAINT channex_create_correlation_unique UNIQUE(id,job_attempt_id,worker_id);

CREATE FUNCTION pms.guard_channex_create_correlation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.job_attempt_id,NEW.worker_id) IS DISTINCT FROM (OLD.job_attempt_id,OLD.worker_id) THEN
      RAISE EXCEPTION 'Creation correlation is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.job_attempt_id IS NOT NULL THEN
    PERFORM 1 FROM platform.job_attempts a
      JOIN platform.jobs j ON j.id=a.job_id
      JOIN pms.channex_offer_targets t ON t.property_id=j.property_id
      WHERE a.id=NEW.job_attempt_id AND a.worker_id=NEW.worker_id AND t.id=NEW.target_id
      FOR SHARE OF a,j;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Creation job correlation mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_create_correlation_guard BEFORE INSERT OR UPDATE
  ON pms.channex_offer_create_attempts FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_create_correlation();

CREATE TABLE pms.channex_offer_create_receipts (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL,
  job_attempt_id UUID NOT NULL,
  worker_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('complete_json','invalid_json','body_limit','body_interrupted','transport_error')),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  provider_request_id TEXT CHECK (octet_length(provider_request_id) BETWEEN 1 AND 512),
  identity_evidence JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(identity_evidence)='object' AND octet_length(identity_evidence::text)<=8192),
  has_warnings BOOLEAN NOT NULL DEFAULT false,
  CHECK (outcome='complete_json' OR identity_evidence='{}'::jsonb),
  CHECK ((outcome='transport_error' AND http_status IS NULL) OR
         (outcome<>'transport_error' AND http_status IS NOT NULL)),
  FOREIGN KEY(attempt_id,job_attempt_id,worker_id)
    REFERENCES pms.channex_offer_create_attempts(id,job_attempt_id,worker_id)
);
CREATE INDEX channex_create_receipts_attempt ON pms.channex_offer_create_receipts(attempt_id);

CREATE FUNCTION pms.guard_channex_create_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Creation receipts are retained and immutable' USING ERRCODE='23514';
  END IF;
  -- Capture and future gates use target-before-attempt locking, regardless of lease state.
  PERFORM 1 FROM pms.channex_offer_targets t
    JOIN pms.channex_offer_create_attempts a ON a.target_id=t.id
    WHERE a.id=NEW.attempt_id FOR UPDATE OF t;
  NEW.captured_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_create_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_create_receipts FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_create_receipt();
