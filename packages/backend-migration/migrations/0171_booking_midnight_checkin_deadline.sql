-- VAY-1283: 00:00 is the explicit end-of-arrival-day check-in deadline.
ALTER TABLE hotel_catalog.property_policy_summaries
  DROP CONSTRAINT chk_property_check_in_window,
  ADD CONSTRAINT chk_property_check_in_window CHECK (
    check_in_until IS NULL OR (
      check_in_time IS NOT NULL
      AND (check_in_until = TIME '00:00' OR check_in_until > check_in_time)
      AND EXTRACT(SECOND FROM check_in_until) = 0
      AND check_in_until < TIME '24:00'
    )
  ) NOT VALID;
