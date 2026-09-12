-- Owner: PMS. Defense at the inventory write boundary complements command checks.
-- No closure writer is enabled by this migration.
CREATE FUNCTION pms.enforce_closed_room_inventory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pms.room_type_closures closure
    WHERE closure.property_id=NEW.property_id AND closure.room_type_id=NEW.room_type_id
      AND NEW.stay_date >= closure.cutoff_date
  ) AND (NEW.status <> 'closed' OR NEW.available_count <> 0
         OR NEW.assigned_count <> 0 OR NEW.blocked_count <> 0) THEN
    RAISE EXCEPTION 'Closing room inventory cannot reopen or acquire occupancy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER closed_room_inventory_fence
BEFORE INSERT OR UPDATE ON pms.inventory_days
FOR EACH ROW EXECUTE FUNCTION pms.enforce_closed_room_inventory();
