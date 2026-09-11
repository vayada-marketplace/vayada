-- VAY-1511: original checkout price evidence, not classified or collected revenue.
CREATE TABLE booking.original_charge_snapshots (
  booking_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  quote_id UUID NOT NULL,
  contract_version TEXT NOT NULL CHECK (contract_version='native-checkout-charge.v1'),
  classification_status TEXT NOT NULL CHECK (classification_status='unclassified'),
  currency CHAR(3) NOT NULL,
  totals JSONB NOT NULL CHECK (jsonb_typeof(totals)='object'),
  selected_offer JSONB NOT NULL CHECK (jsonb_typeof(selected_offer)='object'),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY (booking_id,property_id) REFERENCES booking.guest_bookings(id,property_id),
  FOREIGN KEY (quote_id,property_id) REFERENCES booking.quote_sessions(id,property_id)
);
CREATE TRIGGER original_charge_snapshot_immutable
  BEFORE UPDATE OR DELETE ON booking.original_charge_snapshots
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER original_charge_snapshot_no_truncate
  BEFORE TRUNCATE ON booking.original_charge_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
