-- VAY-1506. Immutable validation evidence for the three authenticated source capabilities.
-- These rows are inputs to a later readiness reader, never booking or earning evidence.
CREATE TABLE booking.affiliate_source_capability_certifications (
  id UUID PRIMARY KEY,
  probe_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  property_id UUID NOT NULL,
  destination_version_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'sandbox')),
  connection_reference TEXT NOT NULL CHECK (length(btrim(connection_reference)) BETWEEN 1 AND 200),
  adapter_version TEXT NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 100),
  capability TEXT NOT NULL CHECK (capability IN (
    'reservation_lifecycle', 'stay_completion', 'accommodation_revenue'
  )),
  validation_kind TEXT NOT NULL DEFAULT 'adapter_certification'
    CHECK (validation_kind='adapter_certification'),
  evidence_scope TEXT NOT NULL DEFAULT 'capability_validation'
    CHECK (evidence_scope='capability_validation'),
  validation_method TEXT NOT NULL DEFAULT 'isolated_synthetic_fixture'
    CHECK (validation_method='isolated_synthetic_fixture'),
  assertion TEXT NOT NULL,
  contract_version TEXT NOT NULL
    CHECK (contract_version='booking-affiliate-source-capability-certification.v1'),
  evidence_references JSONB NOT NULL
    CHECK (booking.valid_affiliate_certification_references(evidence_references)),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  completed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(completed_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (probe_id, capability),
  FOREIGN KEY (booking_id, property_id, probe_id)
    REFERENCES booking.affiliate_validation_booking_bindings(booking_id, property_id, probe_id),
  FOREIGN KEY (probe_id, property_id, destination_version_id, organization_id, environment,
               connection_reference, adapter_version)
    REFERENCES booking.affiliate_validation_probes(id, property_id, destination_version_id,
      organization_id, environment, connection_reference, adapter_version),
  CONSTRAINT chk_affiliate_source_certification_assertion CHECK (
    (capability='reservation_lifecycle' AND assertion='synthetic_reservation_lifecycle_observed')
    OR (capability='stay_completion' AND assertion='synthetic_stay_completion_observed')
    OR (capability='accommodation_revenue' AND assertion='synthetic_accommodation_revenue_observed')
  )
);

CREATE FUNCTION booking.verify_affiliate_source_capability_certification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  completed TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM booking.affiliate_validation_probes probe
  WHERE probe.id=NEW.probe_id
    AND probe.property_id=NEW.property_id
    AND probe.destination_version_id=NEW.destination_version_id
    AND probe.organization_id=NEW.organization_id
    AND probe.environment=NEW.environment
    AND probe.connection_reference=NEW.connection_reference
    AND probe.adapter_version=NEW.adapter_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Affiliate source capability certification scope is unavailable'
      USING ERRCODE='23514';
  END IF;

  completed := clock_timestamp();
  IF EXISTS (
    SELECT 1 FROM booking.affiliate_validation_probes probe
    WHERE probe.id=NEW.probe_id AND probe.expires_at <= completed
  ) OR EXISTS (
    SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
    WHERE revoked.probe_id=NEW.probe_id
  ) OR (
    SELECT count(*) FROM booking.affiliate_validation_booking_bindings binding
    WHERE binding.probe_id=NEW.probe_id
  ) <> 1 THEN
    RAISE EXCEPTION 'Affiliate source capability certification scope is unavailable'
      USING ERRCODE='23514';
  END IF;
  NEW.completed_at := completed;
  RETURN NEW;
END
$$;

CREATE TRIGGER affiliate_source_capability_certification_verify
  BEFORE INSERT ON booking.affiliate_source_capability_certifications
  FOR EACH ROW EXECUTE FUNCTION booking.verify_affiliate_source_capability_certification();
CREATE TRIGGER affiliate_source_capability_certification_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_source_capability_certifications
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_source_capability_certification_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_source_capability_certifications
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TABLE booking.affiliate_source_capability_production_preflights (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  destination_version_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment='production'),
  connection_reference TEXT NOT NULL CHECK (length(btrim(connection_reference)) BETWEEN 1 AND 200),
  adapter_version TEXT NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 100),
  capability TEXT NOT NULL CHECK (capability IN (
    'reservation_lifecycle', 'stay_completion', 'accommodation_revenue'
  )),
  validation_kind TEXT NOT NULL DEFAULT 'production_preflight'
    CHECK (validation_kind='production_preflight'),
  evidence_scope TEXT NOT NULL DEFAULT 'capability_validation'
    CHECK (evidence_scope='capability_validation'),
  preflight_method TEXT NOT NULL DEFAULT 'documented_authenticated_read'
    CHECK (preflight_method='documented_authenticated_read'),
  assertion TEXT NOT NULL,
  evidence_fingerprint_hash TEXT NOT NULL CHECK (evidence_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  contract_version TEXT NOT NULL
    CHECK (contract_version='booking-affiliate-source-capability-production-preflight.v1'),
  evidence_references JSONB NOT NULL
    CHECK (booking.valid_affiliate_certification_references(evidence_references)),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  completed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(completed_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (id, organization_id),
  UNIQUE (evidence_fingerprint_hash),
  FOREIGN KEY (destination_version_id, property_id, organization_id)
    REFERENCES booking.affiliate_destination_versions(id, property_id, created_by_organization_id),
  CONSTRAINT chk_affiliate_source_preflight_assertion CHECK (
    (capability='reservation_lifecycle' AND assertion='authenticated_reservation_lifecycle_read')
    OR (capability='stay_completion' AND assertion='authenticated_stay_completion_read')
    OR (capability='accommodation_revenue' AND assertion='authenticated_accommodation_revenue_read')
  )
);

CREATE TABLE booking.affiliate_source_capability_preflight_revocations (
  preflight_id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY (preflight_id, organization_id)
    REFERENCES booking.affiliate_source_capability_production_preflights(id, organization_id)
);

CREATE FUNCTION booking.complete_affiliate_source_capability_preflight()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.completed_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION booking.lock_affiliate_source_capability_preflight_revocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM booking.affiliate_source_capability_production_preflights preflight
  WHERE preflight.id=NEW.preflight_id AND preflight.organization_id=NEW.organization_id
  FOR UPDATE;
  RETURN NEW;
END
$$;

CREATE TRIGGER affiliate_source_capability_preflight_complete
  BEFORE INSERT ON booking.affiliate_source_capability_production_preflights
  FOR EACH ROW EXECUTE FUNCTION booking.complete_affiliate_source_capability_preflight();
CREATE TRIGGER affiliate_source_capability_preflight_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_source_capability_production_preflights
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_source_capability_preflight_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_source_capability_production_preflights
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_source_capability_preflight_revocation_lock
  BEFORE INSERT ON booking.affiliate_source_capability_preflight_revocations
  FOR EACH ROW EXECUTE FUNCTION booking.lock_affiliate_source_capability_preflight_revocation();
CREATE TRIGGER affiliate_source_capability_preflight_revocation_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_source_capability_preflight_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_source_capability_preflight_revocation_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_source_capability_preflight_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

COMMENT ON TABLE booking.affiliate_source_capability_certifications IS
  'Immutable diagnostic certification for lifecycle, completion or revenue source capability; not production or earning evidence.';
COMMENT ON TABLE booking.affiliate_source_capability_production_preflights IS
  'Immutable non-mutating production source-capability preflight evidence; not a reservation, readiness decision or earning.';
