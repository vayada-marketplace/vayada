-- VAY-2108: ongoing Channex offer ARI (engineering/channex-ongoing-offer-ari.md). Schema only: the
-- worker gets no grants or policies here; the delivery PR adds them with its boundary re-pin.

-- Sales stay closed, also right after activation, until the audited open-sales command.
ALTER TABLE pms.channex_offer_targets
  ADD COLUMN sales_state TEXT NOT NULL DEFAULT 'closed' CHECK (sales_state IN ('closed', 'open')),
  ADD COLUMN sales_state_changed_at TIMESTAMPTZ;

-- One provider POST of collapsed date ranges for one active target.
CREATE TABLE pms.channex_offer_ari_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID NOT NULL REFERENCES pms.channex_offer_targets(id),
  version BIGINT NOT NULL,
  binding_generation UUID NOT NULL,
  external_property_id TEXT NOT NULL,
  external_room_type_id TEXT NOT NULL,
  external_rate_plan_id TEXT NOT NULL,
  job_attempt_id UUID NOT NULL REFERENCES platform.job_attempts(id),
  worker_id TEXT NOT NULL CHECK (worker_id <> '' AND worker_id = btrim(worker_id)),
  request_body JSONB NOT NULL CHECK (
    jsonb_typeof(request_body) = 'object' AND jsonb_typeof(request_body->'values') = 'array'
    AND jsonb_array_length(request_body->'values') BETWEEN 1 AND 100
    AND octet_length(request_body::text) <= 262144),
  state TEXT NOT NULL DEFAULT 'unresolved' CHECK (state IN ('unresolved', 'reconciled', 'released')),
  reconciliation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(reconciliation_evidence) = 'object'
    AND octet_length(reconciliation_evidence::text) <= 8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('unresolved', 'released') AND reconciliation_evidence = '{}'::jsonb) OR
         (state = 'reconciled' AND reconciliation_evidence <> '{}'::jsonb)),
  UNIQUE (id, job_attempt_id, worker_id),
  FOREIGN KEY (target_id, version) REFERENCES pms.channex_offer_target_versions(target_id, version)
);
CREATE UNIQUE INDEX uq_channex_offer_ari_deliveries_unresolved
  ON pms.channex_offer_ari_deliveries(target_id) WHERE state = 'unresolved';
CREATE INDEX idx_channex_offer_ari_deliveries_key ON pms.channex_offer_ari_deliveries
  (binding_generation, external_property_id, external_rate_plan_id, created_at DESC)
  WHERE state = 'reconciled';

-- The exact desired value and its sha for each date a delivery covers: "last sent".
CREATE TABLE pms.channex_offer_ari_delivery_dates (
  delivery_id UUID NOT NULL REFERENCES pms.channex_offer_ari_deliveries(id),
  service_date DATE NOT NULL CHECK (isfinite(service_date)),
  value JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 4096),
  value_sha256 TEXT NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (delivery_id, service_date)
);

CREATE TABLE pms.channex_offer_ari_delivery_receipts (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL,
  job_attempt_id UUID NOT NULL,
  worker_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('complete_json', 'invalid_json', 'body_limit', 'body_interrupted', 'transport_error')),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  provider_request_id TEXT CHECK (length(provider_request_id) BETWEEN 1 AND 512
    AND provider_request_id ~ '^[A-Za-z0-9._:-]+$'),
  task_ids UUID[] NOT NULL DEFAULT '{}' CHECK (cardinality(task_ids) <= 100
    AND array_position(task_ids, NULL) IS NULL),
  has_warnings BOOLEAN NOT NULL,
  warning_reason TEXT CHECK (warning_reason IS NULL OR length(warning_reason) BETWEEN 1 AND 200),
  CHECK (outcome = 'complete_json' OR (cardinality(task_ids) = 0 AND has_warnings)),
  CHECK ((outcome = 'transport_error' AND http_status IS NULL AND provider_request_id IS NULL) OR
         (outcome <> 'transport_error' AND http_status IS NOT NULL)),
  FOREIGN KEY (delivery_id, job_attempt_id, worker_id)
    REFERENCES pms.channex_offer_ari_deliveries(id, job_attempt_id, worker_id)
);

CREATE FUNCTION pms.guard_channex_offer_ari_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
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
    RETURN NEW;
  END IF;
  -- Target before delivery, as in the initial ARI and receipt capture.
  SELECT * INTO target FROM pms.channex_offer_targets WHERE id = NEW.target_id FOR UPDATE;
  IF NOT FOUND OR target.active_version IS NULL OR NEW.state <> 'unresolved' THEN
    RAISE EXCEPTION 'Active offer target and unresolved delivery required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO active FROM pms.channex_offer_target_versions
    WHERE target_id = target.id AND version = target.active_version FOR SHARE;
  PERFORM 1 FROM pms.channel_connections connection
    JOIN platform.jobs job ON job.property_id = connection.property_id
    JOIN platform.job_attempts attempt ON attempt.job_id = job.id
    WHERE connection.id = target.connection_id
      AND connection.binding_generation = active.binding_generation
      AND attempt.id = NEW.job_attempt_id AND attempt.worker_id = NEW.worker_id
    FOR SHARE OF connection, job, attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active binding or job correlation mismatch' USING ERRCODE = '23514';
  END IF;
  -- Never accept caller-supplied provider identity or version.
  NEW.version := active.version;
  NEW.binding_generation := active.binding_generation;
  NEW.external_property_id := active.external_property_id;
  NEW.external_room_type_id := active.external_room_type_id;
  NEW.external_rate_plan_id := active.external_rate_plan_id;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_ari_delivery_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_ari_deliveries FOR EACH ROW EXECUTE FUNCTION pms.guard_channex_offer_ari_delivery();

CREATE FUNCTION pms.guard_channex_offer_ari_delivery_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Offer ARI delivery dates retained' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM pms.channex_offer_ari_deliveries
    WHERE id = NEW.delivery_id AND state = 'unresolved' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dates belong to an unresolved delivery' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channex_offer_ari_delivery_date_guard BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_offer_ari_delivery_dates FOR EACH ROW
  EXECUTE FUNCTION pms.guard_channex_offer_ari_delivery_date();

CREATE FUNCTION pms.guard_channex_offer_ari_delivery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Offer ARI delivery receipts retained' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER channex_offer_ari_delivery_receipt_guard BEFORE UPDATE OR DELETE
  ON pms.channex_offer_ari_delivery_receipts FOR EACH ROW
  EXECUTE FUNCTION pms.guard_channex_offer_ari_delivery_receipt();

-- Provider evidence is the worker's alone; the VAY-2054 default privileges would let the API write it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vayada_next_api_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON pms.channex_offer_ari_deliveries, pms.channex_offer_ari_delivery_dates,
         pms.channex_offer_ari_delivery_receipts
      FROM vayada_next_api_runtime;
  END IF;
END $$;
