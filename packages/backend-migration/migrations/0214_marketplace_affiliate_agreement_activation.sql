-- VAY-1502. Stable agreement identity and initial activation evidence only.
-- Pause, resume, end and replacement-term history require later lifecycle events.
ALTER TABLE marketplace.affiliate_participations
  ADD CONSTRAINT uq_affiliate_participation_activation_scope
  UNIQUE (id, program_id, creator_profile_id, creator_organization_id);
ALTER TABLE marketplace.affiliate_participation_attempts
  ADD CONSTRAINT uq_affiliate_attempt_activation_scope
  UNIQUE (id, participation_id, program_id, terms_id);
ALTER TABLE marketplace.affiliate_assent_decisions
  ADD CONSTRAINT uq_affiliate_decision_activation_scope
  UNIQUE (id, attempt_id, terms_id, decision);

CREATE TABLE marketplace.affiliate_agreements (
  id UUID PRIMARY KEY,
  participation_id UUID NOT NULL,
  program_id UUID NOT NULL,
  offer_id UUID NOT NULL,
  property_id UUID NOT NULL,
  hotel_organization_id UUID NOT NULL,
  creator_profile_id UUID NOT NULL,
  creator_organization_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (id, participation_id),
  FOREIGN KEY (program_id, offer_id, property_id, hotel_organization_id)
    REFERENCES marketplace.affiliate_programs(id, offer_id, property_id, organization_id),
  FOREIGN KEY (participation_id, program_id, creator_profile_id, creator_organization_id)
    REFERENCES marketplace.affiliate_participations(id, program_id, creator_profile_id, creator_organization_id)
);

CREATE TABLE marketplace.affiliate_agreement_activations (
  id UUID PRIMARY KEY,
  agreement_id UUID NOT NULL UNIQUE,
  participation_id UUID NOT NULL,
  program_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  terms_id UUID NOT NULL,
  hotel_approval_id UUID NOT NULL,
  hotel_decision TEXT NOT NULL DEFAULT 'hotel_approval' CHECK (hotel_decision = 'hotel_approval'),
  creator_acceptance_id UUID NOT NULL,
  creator_decision TEXT NOT NULL DEFAULT 'creator_acceptance' CHECK (creator_decision = 'creator_acceptance'),
  contract_version TEXT NOT NULL CHECK (contract_version = 'marketplace-affiliate-agreement-activation.v1'),
  readiness_evidence JSONB NOT NULL
    CHECK (jsonb_typeof(readiness_evidence) = 'array' AND jsonb_array_length(readiness_evidence) > 0),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  effective_at TIMESTAMPTZ NOT NULL CHECK (isfinite(effective_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (attempt_id),
  FOREIGN KEY (agreement_id, participation_id)
    REFERENCES marketplace.affiliate_agreements(id, participation_id),
  FOREIGN KEY (attempt_id, participation_id, program_id, terms_id)
    REFERENCES marketplace.affiliate_participation_attempts(id, participation_id, program_id, terms_id),
  FOREIGN KEY (hotel_approval_id, attempt_id, terms_id, hotel_decision)
    REFERENCES marketplace.affiliate_assent_decisions(id, attempt_id, terms_id, decision),
  FOREIGN KEY (creator_acceptance_id, attempt_id, terms_id, creator_decision)
    REFERENCES marketplace.affiliate_assent_decisions(id, attempt_id, terms_id, decision)
);

CREATE TRIGGER affiliate_agreements_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_agreements
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_agreements_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_agreements
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_agreement_activations_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_agreement_activations
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_agreement_activations_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_agreement_activations
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
