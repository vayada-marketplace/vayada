-- VAY-1506. Immutable production preflight evidence only.
-- This never represents a reservation, readiness decision or earning event.
CREATE TABLE booking.affiliate_referral_production_preflights (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  destination_version_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment='production'),
  connection_reference TEXT NOT NULL CHECK (length(btrim(connection_reference)) BETWEEN 1 AND 200),
  adapter_version TEXT NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 100),
  capability TEXT NOT NULL DEFAULT 'referral_round_trip'
    CHECK (capability='referral_round_trip'),
  validation_kind TEXT NOT NULL DEFAULT 'production_preflight'
    CHECK (validation_kind='production_preflight'),
  evidence_scope TEXT NOT NULL DEFAULT 'capability_validation'
    CHECK (evidence_scope='capability_validation'),
  preflight_method TEXT NOT NULL DEFAULT 'documented_non_mutating_round_trip'
    CHECK (preflight_method='documented_non_mutating_round_trip'),
  assertion TEXT NOT NULL DEFAULT 'opaque_correlation_returned_without_booking'
    CHECK (assertion='opaque_correlation_returned_without_booking'),
  correlation_hash TEXT NOT NULL CHECK (correlation_hash ~ '^[a-f0-9]{64}$'),
  contract_version TEXT NOT NULL
    CHECK (contract_version='booking-affiliate-referral-production-preflight.v1'),
  evidence_references JSONB NOT NULL
    CHECK (booking.valid_affiliate_certification_references(evidence_references)),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  completed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(completed_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (id, organization_id),
  UNIQUE (correlation_hash),
  FOREIGN KEY (destination_version_id, property_id, organization_id)
    REFERENCES booking.affiliate_destination_versions(id, property_id, created_by_organization_id)
);

CREATE TABLE booking.affiliate_referral_production_preflight_revocations (
  preflight_id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY (preflight_id, organization_id)
    REFERENCES booking.affiliate_referral_production_preflights(id, organization_id)
);

CREATE FUNCTION booking.complete_affiliate_referral_production_preflight()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.completed_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION booking.lock_affiliate_referral_production_preflight_revocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM booking.affiliate_referral_production_preflights preflight
  WHERE preflight.id=NEW.preflight_id AND preflight.organization_id=NEW.organization_id
  FOR UPDATE;
  RETURN NEW;
END
$$;

CREATE TRIGGER affiliate_referral_production_preflight_complete
  BEFORE INSERT ON booking.affiliate_referral_production_preflights
  FOR EACH ROW EXECUTE FUNCTION booking.complete_affiliate_referral_production_preflight();
CREATE TRIGGER affiliate_referral_production_preflight_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_referral_production_preflights
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_referral_production_preflight_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_referral_production_preflights
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_referral_production_preflight_revocation_lock
  BEFORE INSERT ON booking.affiliate_referral_production_preflight_revocations
  FOR EACH ROW EXECUTE FUNCTION booking.lock_affiliate_referral_production_preflight_revocation();
CREATE TRIGGER affiliate_referral_production_preflight_revocation_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_referral_production_preflight_revocations
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_referral_production_preflight_revocation_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_referral_production_preflight_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

COMMENT ON TABLE booking.affiliate_referral_production_preflights IS
  'Immutable non-mutating production referral preflight evidence. Not sufficient for readiness or earnings.';
