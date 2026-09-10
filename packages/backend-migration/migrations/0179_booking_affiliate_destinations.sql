-- VAY-1501. Configuration only; never tracking verification or publication.
-- Design: engineering/affiliate-booking-destinations.md
CREATE TABLE booking.affiliate_destination_versions (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  booking_url TEXT NOT NULL CHECK (length(booking_url) BETWEEN 1 AND 2048 AND booking_url LIKE 'https://%'),
  created_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_by_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(recorded_at)),
  UNIQUE (id, property_id)
);
CREATE INDEX idx_affiliate_destination_property
  ON booking.affiliate_destination_versions(property_id, created_by_organization_id, recorded_at, id);
COMMENT ON TABLE booking.affiliate_destination_versions IS
  'Immutable hotel-supplied configuration. No ownership, provider or tracking verification implied.';
CREATE TRIGGER affiliate_destination_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_destination_versions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_destination_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_destination_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
