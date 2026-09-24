-- VAY-1506. The future affiliate capture login receives UPDATE only to take
-- row locks. These mutation guards must also fire when replication mode is
-- configured before login, which bypasses ordinary triggers.
ALTER TABLE marketplace.affiliate_agreement_activations
  ENABLE ALWAYS TRIGGER affiliate_agreement_activations_immutable;
ALTER TABLE marketplace.affiliate_agreement_lifecycle_events
  ENABLE ALWAYS TRIGGER affiliate_agreement_lifecycle_events_immutable;
ALTER TABLE marketplace.affiliate_published_terms
  ENABLE ALWAYS TRIGGER affiliate_published_terms_immutable;
ALTER TABLE booking.affiliate_destination_versions
  ENABLE ALWAYS TRIGGER affiliate_destination_immutable;
ALTER TABLE booking.affiliate_referral_transport_certifications
  ENABLE ALWAYS TRIGGER affiliate_referral_transport_certification_immutable;
ALTER TABLE booking.affiliate_validation_probes
  ENABLE ALWAYS TRIGGER affiliate_validation_probe_immutable;
ALTER TABLE booking.affiliate_referral_production_preflights
  ENABLE ALWAYS TRIGGER affiliate_referral_production_preflight_immutable;
