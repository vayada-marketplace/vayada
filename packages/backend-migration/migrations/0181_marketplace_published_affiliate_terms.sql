-- VAY-1501. Immutable publication, not creator acceptance or earning activation.
-- Design: engineering/marketplace-affiliate-agreements.md
ALTER TABLE marketplace.affiliate_offer_terms_drafts
  ADD CONSTRAINT uq_affiliate_draft_publication_scope UNIQUE (id, offer_id, property_id, organization_id);
CREATE TABLE marketplace.affiliate_programs (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL UNIQUE,
  property_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  UNIQUE(id, offer_id, property_id, organization_id),
  FOREIGN KEY (offer_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_offers(id, property_id, organization_id)
);
CREATE TABLE marketplace.affiliate_published_terms (
  id UUID PRIMARY KEY,
  program_id UUID NOT NULL,
  offer_id UUID NOT NULL,
  property_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  source_draft_id UUID NOT NULL UNIQUE,
  -- Complete immutable creator-visible disclosure, resolved by a trusted publication port.
  disclosure TEXT NOT NULL CHECK (jsonb_typeof(disclosure::jsonb) = 'object' AND disclosure::jsonb <> '{}'::jsonb),
  disclosure_hash TEXT NOT NULL CHECK (disclosure_hash ~ '^[0-9a-f]{64}$'),
  attribution_policy_version TEXT NOT NULL CHECK (length(btrim(attribution_policy_version)) BETWEEN 1 AND 200),
  evidence_references JSONB NOT NULL CHECK (jsonb_typeof(evidence_references) = 'array' AND jsonb_array_length(evidence_references) > 0),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  effective_at TIMESTAMPTZ NOT NULL CHECK (isfinite(effective_at)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY (program_id, offer_id, property_id, organization_id)
    REFERENCES marketplace.affiliate_programs(id, offer_id, property_id, organization_id),
  FOREIGN KEY (source_draft_id, offer_id, property_id, organization_id)
    REFERENCES marketplace.affiliate_offer_terms_drafts(id, offer_id, property_id, organization_id)
);
CREATE TRIGGER affiliate_programs_immutable BEFORE UPDATE OR DELETE ON marketplace.affiliate_programs
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_programs_no_truncate BEFORE TRUNCATE ON marketplace.affiliate_programs
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_published_terms_immutable BEFORE UPDATE OR DELETE ON marketplace.affiliate_published_terms
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_published_terms_no_truncate BEFORE TRUNCATE ON marketplace.affiliate_published_terms
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
