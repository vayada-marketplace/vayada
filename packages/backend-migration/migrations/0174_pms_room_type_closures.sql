-- Owner: PMS. Contract: engineering/pms-room-retirement-contract.md.
-- Dormant prerequisite: no command writes this receipt until all closure fences ship.
CREATE TABLE pms.room_type_closures (
  property_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  command_id UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_room_facts_revision BIGINT NOT NULL CHECK (expected_room_facts_revision > 0),
  expected_room_units_revision BIGINT NOT NULL CHECK (expected_room_units_revision > 0),
  previous_calendar_revision BIGINT NOT NULL CHECK (previous_calendar_revision > 0),
  closed_calendar_revision BIGINT NOT NULL,
  cutoff_date DATE NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  PRIMARY KEY (property_id, room_type_id),
  UNIQUE (property_id, command_id),
  FOREIGN KEY (room_type_id, property_id) REFERENCES pms.room_types(id, property_id),
  CHECK (closed_calendar_revision = previous_calendar_revision + 1)
);

-- Receipts survive final soft-retirement and cannot be cleared by command replay.
CREATE FUNCTION pms.reject_room_type_closure_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Room closure receipts are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER room_type_closure_immutable
BEFORE UPDATE OR DELETE ON pms.room_type_closures
FOR EACH ROW EXECUTE FUNCTION pms.reject_room_type_closure_rewrite();
