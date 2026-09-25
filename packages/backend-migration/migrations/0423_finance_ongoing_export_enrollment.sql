-- VAY-1134: all-hotel enrollment; execution remains disabled until explicit runtime activation.
CREATE FUNCTION platform.enroll_finance_export_property()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO platform.finance_export_worker_properties(property_id)
  VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.enroll_finance_export_property() FROM PUBLIC;
CREATE TRIGGER enroll_finance_export_property
AFTER INSERT ON hotel_catalog.properties
FOR EACH ROW EXECUTE FUNCTION platform.enroll_finance_export_property();
COMMENT ON FUNCTION platform.enroll_finance_export_property() IS
  'Enroll newly created hotels for the dedicated export worker; no direct runtime EXECUTE permission.';
-- Enrollment follows property lifetime; job/finance references retain their own deletion constraints.
ALTER TABLE platform.finance_export_worker_properties
DROP CONSTRAINT finance_export_worker_properties_property_id_fkey,
ADD CONSTRAINT finance_export_worker_properties_property_id_fkey
FOREIGN KEY(property_id) REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE;

-- Trigger installation locks property writes until this transaction commits.
INSERT INTO platform.finance_export_worker_properties(property_id)
SELECT id FROM hotel_catalog.properties ON CONFLICT DO NOTHING;
