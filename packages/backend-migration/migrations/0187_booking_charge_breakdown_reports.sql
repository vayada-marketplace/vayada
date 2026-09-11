-- VAY-1511: unverified component reports, never accepted/collected revenue.
-- Native scope is anchored to existing immutable original charge evidence.
-- Design: engineering/affiliate-accommodation-revenue-evidence.md
CREATE TABLE booking.charge_breakdown_reports (
  id UUID PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES booking.original_charge_snapshots(booking_id),
  property_id UUID NOT NULL,
  contract_version TEXT NOT NULL CHECK (contract_version = 'booking-charge-report.v1'),
  evidence_status TEXT NOT NULL CHECK (evidence_status = 'unverified'),
  purpose TEXT NOT NULL CHECK (purpose IN ('diagnostic', 'live')),
  environment TEXT NOT NULL CHECK (environment IN ('local', 'sandbox', 'production')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('hotel_reported', 'connected_system')),
  source_connection TEXT NOT NULL CHECK (source_connection=btrim(source_connection) AND length(source_connection) BETWEEN 1 AND 200),
  source_record TEXT NOT NULL CHECK (source_record=btrim(source_record) AND length(source_record) BETWEEN 1 AND 200),
  source_revision TEXT NOT NULL CHECK (source_revision=btrim(source_revision) AND length(source_revision) BETWEEN 1 AND 200),
  source_contract TEXT NOT NULL CHECK (source_contract=btrim(source_contract) AND length(source_contract) BETWEEN 1 AND 200),
  reported_charge_reference TEXT NOT NULL CHECK (reported_charge_reference=btrim(reported_charge_reference) AND length(reported_charge_reference) BETWEEN 1 AND 200),
  reported_item_reference TEXT NOT NULL CHECK (reported_item_reference=btrim(reported_item_reference) AND length(reported_item_reference) BETWEEN 1 AND 200),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  minor_unit_scale SMALLINT NOT NULL CHECK (minor_unit_scale BETWEEN 0 AND 3),
  accommodation_minor NUMERIC NOT NULL CHECK (accommodation_minor BETWEEN 0 AND 99999999999999999999 AND accommodation_minor=trunc(accommodation_minor)),
  tax_minor NUMERIC NOT NULL CHECK (tax_minor BETWEEN 0 AND 99999999999999999999 AND tax_minor=trunc(tax_minor)),
  extras_minor NUMERIC NOT NULL CHECK (extras_minor BETWEEN 0 AND 99999999999999999999 AND extras_minor=trunc(extras_minor)),
  other_minor NUMERIC NOT NULL CHECK (other_minor BETWEEN 0 AND 99999999999999999999 AND other_minor=trunc(other_minor)),
  total_minor NUMERIC NOT NULL CHECK (total_minor BETWEEN 0 AND 99999999999999999999 AND total_minor=trunc(total_minor)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  supersedes_id UUID UNIQUE,
  supersedes_revision INTEGER GENERATED ALWAYS AS (revision - 1) STORED,
  actor_user_id UUID REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (request_id=btrim(request_id) AND length(request_id) BETWEEN 1 AND 200),
  observed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(observed_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  CHECK (source_kind <> 'hotel_reported' OR actor_user_id IS NOT NULL),
  CHECK (purpose <> 'live' OR environment = 'production'),
  CHECK (total_minor = accommodation_minor + tax_minor + extras_minor + other_minor),
  CHECK ((revision = 1) = (supersedes_id IS NULL)),
  FOREIGN KEY (booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id),
  UNIQUE (property_id, source_kind, source_connection, environment, purpose, source_record, source_revision),
  UNIQUE (property_id, source_kind, source_connection, environment, purpose, source_record, revision),
  UNIQUE (id, booking_id, property_id, source_kind, source_connection, environment, purpose, source_record, revision),
  FOREIGN KEY (supersedes_id, booking_id, property_id, source_kind, source_connection, environment, purpose, source_record, supersedes_revision)
    REFERENCES booking.charge_breakdown_reports
      (id, booking_id, property_id, source_kind, source_connection, environment, purpose, source_record, revision)
);
CREATE TRIGGER charge_breakdown_reports_immutable
  BEFORE UPDATE OR DELETE ON booking.charge_breakdown_reports
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER charge_breakdown_reports_no_truncate
  BEFORE TRUNCATE ON booking.charge_breakdown_reports
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
