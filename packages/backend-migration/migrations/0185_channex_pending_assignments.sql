-- VAY-1981: provider room reservations have exact stays before physical allocation.
-- Preserve manual and migration assignment constraints.
CREATE OR REPLACE FUNCTION pms.enforce_assignment_positions_contiguous()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stay_evidence_kind = 'exact' AND NEW.room_id IS NULL
    AND NOT (
      NEW.source = 'migration'
      AND NEW.assignment_payload #>> '{migrationRunId}' ~ '^vay1351-[0-9a-f]{24}$'
    )
    AND NOT (NEW.source = 'channel' AND NEW.assignment_status = 'pending'
      AND COALESCE(NEW.assignment_payload->>'contractVersion' = 'channex-operational-assignment.v1', FALSE))
    AND (TG_OP = 'INSERT' OR NEW.stay_evidence_kind IS DISTINCT FROM OLD.stay_evidence_kind)
  THEN
    RAISE EXCEPTION 'new exact assignments require a room' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'chk_pms_exact_assignments_room';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.source = 'manual' AND NEW.stay_evidence_kind <> 'exact'
    AND (TG_OP = 'INSERT' OR (NEW.source, NEW.stay_evidence_kind)
      IS DISTINCT FROM (OLD.source, OLD.stay_evidence_kind)) THEN
    RAISE EXCEPTION 'new manual assignments require exact stay evidence' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'chk_pms_manual_assignments_exact';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM pms.assert_assignment_positions_contiguous(OLD.guest_booking_id, OLD.property_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (
    TG_OP = 'INSERT'
    OR (NEW.guest_booking_id, NEW.property_id) IS DISTINCT FROM
       (OLD.guest_booking_id, OLD.property_id)
  ) THEN
    PERFORM pms.assert_assignment_positions_contiguous(NEW.guest_booking_id, NEW.property_id);
  END IF;
  RETURN NULL;
END;
$$;

