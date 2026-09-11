-- VAY-1506: diagnostic quote identity, never creator attribution.
CREATE TABLE booking.affiliate_validation_quote_bindings (
  quote_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  probe_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY(quote_id,property_id) REFERENCES booking.quote_sessions(id,property_id),
  FOREIGN KEY(probe_id,property_id) REFERENCES booking.affiliate_validation_probes(id,property_id)
);
CREATE TRIGGER affiliate_probe_quote_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_validation_quote_bindings
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_probe_quote_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_validation_quote_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
