-- VAY-1506. Successful diagnostic referral transport evidence only.
-- This is the adapter-certification half of readiness, never production preflight or earning evidence.
ALTER TABLE booking.affiliate_validation_probes
  ADD CONSTRAINT uq_affiliate_probe_certification_scope
  UNIQUE (id, property_id, destination_version_id, organization_id, environment,
          connection_reference, adapter_version);

ALTER TABLE booking.affiliate_validation_booking_bindings
  ADD CONSTRAINT uq_affiliate_probe_binding_certification_scope
  UNIQUE (booking_id, property_id, probe_id);

CREATE FUNCTION booking.valid_affiliate_certification_references(value JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN
    jsonb_array_length(value) BETWEEN 1 AND 100
      AND octet_length(value::text) <= 32768
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value) reference
        WHERE jsonb_typeof(reference) <> 'string'
          OR length(reference #>> '{}') NOT BETWEEN 1 AND 256
          OR (reference #>> '{}') !~ '[^[:space:]]'
      )
  ELSE FALSE END
$$;

CREATE TABLE booking.affiliate_referral_transport_certifications (
  id UUID PRIMARY KEY,
  probe_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  property_id UUID NOT NULL,
  destination_version_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('local', 'sandbox')),
  connection_reference TEXT NOT NULL CHECK (length(btrim(connection_reference)) BETWEEN 1 AND 200),
  adapter_version TEXT NOT NULL CHECK (length(btrim(adapter_version)) BETWEEN 1 AND 100),
  capability TEXT NOT NULL DEFAULT 'referral_round_trip'
    CHECK (capability = 'referral_round_trip'),
  validation_kind TEXT NOT NULL DEFAULT 'adapter_certification'
    CHECK (validation_kind = 'adapter_certification'),
  evidence_scope TEXT NOT NULL DEFAULT 'capability_validation'
    CHECK (evidence_scope = 'capability_validation'),
  contract_version TEXT NOT NULL
    CHECK (contract_version = 'booking-affiliate-referral-transport-certification.v1'),
  evidence_references JSONB NOT NULL
    CHECK (booking.valid_affiliate_certification_references(evidence_references)),
  actor_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  completed_at TIMESTAMPTZ NOT NULL CHECK (isfinite(completed_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (probe_id, capability, validation_kind),
  FOREIGN KEY (booking_id, property_id, probe_id)
    REFERENCES booking.affiliate_validation_booking_bindings(booking_id, property_id, probe_id),
  FOREIGN KEY (probe_id, property_id, destination_version_id, organization_id, environment,
               connection_reference, adapter_version)
    REFERENCES booking.affiliate_validation_probes(id, property_id, destination_version_id,
      organization_id, environment, connection_reference, adapter_version)
);

CREATE FUNCTION booking.verify_affiliate_referral_transport_certification()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  completed TIMESTAMPTZ;
BEGIN
  PERFORM 1 FROM booking.affiliate_validation_probes probe
  WHERE probe.id = NEW.probe_id
    AND probe.property_id = NEW.property_id
    AND probe.destination_version_id = NEW.destination_version_id
    AND probe.organization_id = NEW.organization_id
    AND probe.environment = NEW.environment
    AND probe.connection_reference = NEW.connection_reference
    AND probe.adapter_version = NEW.adapter_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Affiliate referral transport certification scope is unavailable'
      USING ERRCODE = '23514';
  END IF;

  completed := clock_timestamp();
  IF EXISTS (
    SELECT 1 FROM booking.affiliate_validation_probes probe
    WHERE probe.id = NEW.probe_id AND probe.expires_at <= completed
  ) OR EXISTS (
    SELECT 1 FROM booking.affiliate_validation_probe_revocations revoked
    WHERE revoked.probe_id = NEW.probe_id
  ) OR (
    SELECT count(*) FROM booking.affiliate_validation_booking_bindings binding
    WHERE binding.probe_id = NEW.probe_id
  ) <> 1 THEN
    RAISE EXCEPTION 'Affiliate referral transport certification scope is unavailable'
      USING ERRCODE = '23514';
  END IF;
  NEW.completed_at := completed;
  RETURN NEW;
END
$$;

CREATE FUNCTION booking.lock_affiliate_validation_probe_for_revocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM booking.affiliate_validation_probes probe
  WHERE probe.id = NEW.probe_id
  FOR UPDATE;
  RETURN NEW;
END
$$;

CREATE FUNCTION booking.prevent_duplicate_affiliate_probe_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM booking.affiliate_validation_probes probe
  WHERE probe.id = NEW.probe_id
  FOR UPDATE;
  IF FOUND AND EXISTS (
    SELECT 1 FROM booking.affiliate_validation_booking_bindings binding
    WHERE binding.probe_id = NEW.probe_id
  ) THEN
    RAISE EXCEPTION 'Affiliate validation probe already has a booking binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER affiliate_validation_booking_binding_single_delivery
  BEFORE INSERT ON booking.affiliate_validation_booking_bindings
  FOR EACH ROW EXECUTE FUNCTION booking.prevent_duplicate_affiliate_probe_binding();

CREATE TRIGGER affiliate_validation_probe_revocation_serialize
  BEFORE INSERT ON booking.affiliate_validation_probe_revocations
  FOR EACH ROW EXECUTE FUNCTION booking.lock_affiliate_validation_probe_for_revocation();

CREATE TRIGGER affiliate_referral_transport_certification_verify
  BEFORE INSERT ON booking.affiliate_referral_transport_certifications
  FOR EACH ROW EXECUTE FUNCTION booking.verify_affiliate_referral_transport_certification();

CREATE TRIGGER affiliate_referral_transport_certification_immutable
  BEFORE UPDATE OR DELETE ON booking.affiliate_referral_transport_certifications
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_referral_transport_certification_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_referral_transport_certifications
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

COMMENT ON TABLE booking.affiliate_referral_transport_certifications IS
  'Immutable successful local/sandbox referral round-trip certification. Diagnostic only; production preflight and earning eligibility are separate.';
