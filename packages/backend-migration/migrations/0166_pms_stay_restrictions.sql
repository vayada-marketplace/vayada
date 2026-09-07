-- VAY-1528: preserve arrival-based, most-restrictive rule composition.
ALTER TABLE pms.rate_rules
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN stop_sell BOOLEAN NOT NULL DEFAULT FALSE;

CREATE FUNCTION pms.effective_stay_restrictions(
  property UUID, room UUID, plan UUID, day DATE
) RETURNS TABLE (
  min_stay_arrival INTEGER, min_stay_through INTEGER, max_stay INTEGER,
  closed_to_arrival BOOLEAN, closed_to_departure BOOLEAN, stop_sell BOOLEAN
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  SELECT COALESCE(MAX(rule.min_stay_nights),
    (SELECT default_minimum_stay_nights FROM pms.operating_calendar_revisions
     WHERE property_id=property ORDER BY calendar_revision DESC LIMIT 1), 1), 1,
    COALESCE(MIN(rule.max_stay_nights), 0),
    COALESCE(BOOL_OR(rule.closed_to_arrival), FALSE),
    COALESCE(BOOL_OR(rule.closed_to_departure), FALSE),
    COALESCE(BOOL_OR(rule.stop_sell), FALSE)
  INTO min_stay_arrival, min_stay_through, max_stay,
    closed_to_arrival, closed_to_departure, stop_sell
  FROM pms.rate_rules rule
  WHERE rule.property_id=property AND rule.room_type_id=room
    AND (rule.rate_plan_id IS NULL OR rule.rate_plan_id=plan) AND rule.enabled
    AND day BETWEEN rule.starts_on AND rule.ends_on
    AND EXTRACT(DOW FROM day)::integer=ANY(rule.days_of_week);
  IF max_stay > 0 AND min_stay_arrival > max_stay THEN
    RAISE EXCEPTION 'Conflicting minimum and maximum stay restrictions' USING ERRCODE='23514';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pms.stay_restrictions_allow(property UUID, room UUID, plan UUID, arrival DATE, departure DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM generate_series(arrival,departure,interval '1 day') day
    CROSS JOIN LATERAL pms.effective_stay_restrictions(property,room,plan,day::date) rule
    WHERE (day::date=arrival AND (rule.closed_to_arrival OR rule.min_stay_arrival>departure-arrival
      OR (rule.max_stay>0 AND rule.max_stay<departure-arrival)))
      OR (day::date=departure AND rule.closed_to_departure)
      OR (day::date<departure AND rule.stop_sell))
$$;

-- At commit, validate every contributing writer, including calendar defaults.
-- Restrictions repeat weekly between boundaries; checking the seven weekdays
-- following each boundary is sufficient even for long-lived rules.
CREATE FUNCTION pms.validate_stay_restrictions() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_property UUID := COALESCE(NEW.property_id,OLD.property_id);
BEGIN
  PERFORM effective.* FROM pms.rate_plans plan
  CROSS JOIN LATERAL (
    SELECT DISTINCT boundary + weekday AS day
    FROM pms.rate_rules rule
    CROSS JOIN LATERAL (VALUES(rule.starts_on),(rule.ends_on+1)) dates(boundary)
    CROSS JOIN generate_series(0,6) weekday
    WHERE rule.property_id=plan.property_id AND rule.room_type_id=plan.room_type_id AND rule.enabled
  ) dates
  CROSS JOIN LATERAL pms.effective_stay_restrictions(plan.property_id,plan.room_type_id,plan.id,dates.day) effective
  WHERE plan.property_id=target_property;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER pms_validate_stay_restrictions
  AFTER INSERT OR UPDATE OR DELETE ON pms.rate_rules DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_stay_restrictions();
CREATE CONSTRAINT TRIGGER pms_validate_calendar_stay_restrictions
  AFTER INSERT OR UPDATE OR DELETE ON pms.operating_calendar_revisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pms.validate_stay_restrictions();

CREATE FUNCTION pms.lock_stay_restrictions() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'pms-inventory:'||COALESCE(NEW.property_id,OLD.property_id)::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER pms_lock_stay_restrictions BEFORE INSERT OR UPDATE OR DELETE ON pms.rate_rules
  FOR EACH ROW EXECUTE FUNCTION pms.lock_stay_restrictions();
CREATE TRIGGER pms_lock_calendar_stay_restrictions BEFORE INSERT ON pms.operating_calendar_revisions
  FOR EACH ROW EXECUTE FUNCTION pms.lock_stay_restrictions();
