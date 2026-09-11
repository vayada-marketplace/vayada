-- VAY-1506. Original diagnostic binding only; never creator attribution.
ALTER TABLE booking.affiliate_validation_probes ADD CONSTRAINT affiliate_probe_property UNIQUE(id,property_id);
CREATE TABLE booking.affiliate_validation_booking_bindings (
  booking_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  probe_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY(booking_id,property_id) REFERENCES booking.guest_bookings(id,property_id),
  FOREIGN KEY(probe_id,property_id) REFERENCES booking.affiliate_validation_probes(id,property_id)
);
CREATE TRIGGER affiliate_probe_binding_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_validation_booking_bindings
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_probe_binding_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_validation_booking_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
