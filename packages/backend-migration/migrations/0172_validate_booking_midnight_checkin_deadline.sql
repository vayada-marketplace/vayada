-- Existing rows satisfied the stricter pre-0171 constraint; validate the relaxed replacement.
ALTER TABLE hotel_catalog.property_policy_summaries
  VALIDATE CONSTRAINT chk_property_check_in_window;
