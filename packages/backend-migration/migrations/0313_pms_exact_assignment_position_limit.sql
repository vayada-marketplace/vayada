-- Replacement pricing accepts up to 99 ordered room selections and migration
-- 0312 validates complete bundles to that same bound. Keep PMS assignment
-- positions aligned so every accepted room can be adopted atomically.
ALTER TABLE pms.operational_booking_assignments
  DROP CONSTRAINT chk_pms_operational_assignments_position,
  ADD CONSTRAINT chk_pms_operational_assignments_position
    CHECK (position >= 1 AND (stay_evidence_kind = 'summary_only' OR position <= 99));
