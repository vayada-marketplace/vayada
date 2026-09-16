-- Availability dispatch is not runtime-wired yet, so history here would be an
-- unexpected rollout violation. Abort instead of retaining unprovable attempts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pms.channex_room_availability_attempts) THEN
    RAISE EXCEPTION
      'Cannot add room availability evidence digest: unexpected attempts already exist'
      USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE pms.channex_room_availability_attempts
  ADD COLUMN inventory_evidence_sha256 TEXT NOT NULL
  CHECK (inventory_evidence_sha256 ~ '^[a-f0-9]{64}$');

ALTER TABLE pms.channex_room_availability_receipts
  ADD CONSTRAINT channex_room_availability_receipt_attempt_identity
  UNIQUE(id,attempt_id);

-- Ordinary application paths write this only through authoritative reconciliation,
-- in the same transaction as the terminal attempt transition. Direct database
-- writers are privileged and trusted. The coordinator requires this immutable row.
CREATE TABLE pms.channex_room_availability_reconciliation_attestations (
  attempt_id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL UNIQUE,
  inventory_evidence_sha256 TEXT NOT NULL
    CHECK (inventory_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  observations_sha256 TEXT NOT NULL
    CHECK (observations_sha256 ~ '^[a-f0-9]{64}$'),
  reconciliation_evidence JSONB NOT NULL CHECK (
    jsonb_typeof(reconciliation_evidence)='object' AND
    reconciliation_evidence<>'{}'::jsonb AND
    octet_length(reconciliation_evidence::text)<=8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id) REFERENCES pms.channex_room_availability_attempts(id),
  FOREIGN KEY(receipt_id,attempt_id)
    REFERENCES pms.channex_room_availability_receipts(id,attempt_id)
);

CREATE FUNCTION pms.guard_channex_room_availability_reconciliation_attestation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Room availability reconciliation attestations are retained and immutable'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pms.channex_room_availability_attempts attempt
    WHERE attempt.id=NEW.attempt_id AND attempt.state='unresolved'
      AND attempt.inventory_evidence_sha256=NEW.inventory_evidence_sha256
  ) OR NEW.reconciliation_evidence->>'inventoryEvidenceSha256' IS DISTINCT FROM
         NEW.inventory_evidence_sha256
     OR NEW.reconciliation_evidence->>'observationsSha256' IS DISTINCT FROM
         NEW.observations_sha256 THEN
    RAISE EXCEPTION 'Current unresolved attempt and exact reconciliation evidence required'
      USING ERRCODE='23514';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER channex_room_availability_reconciliation_attestation_guard
  BEFORE INSERT OR UPDATE OR DELETE
  ON pms.channex_room_availability_reconciliation_attestations
  FOR EACH ROW EXECUTE FUNCTION
    pms.guard_channex_room_availability_reconciliation_attestation();
