-- VAY-1502. Assent evidence only; no activation or collaboration lifecycle.
-- Design: engineering/marketplace-affiliate-agreements.md (PR1918).
ALTER TABLE marketplace.affiliate_published_terms
  ADD UNIQUE (id, program_id), ADD UNIQUE (id, disclosure_hash);

-- Stable identity survives later application/invitation attempts and terms versions.
CREATE TABLE marketplace.affiliate_participations (
  id UUID PRIMARY KEY,
  program_id UUID NOT NULL REFERENCES marketplace.affiliate_programs(id),
  creator_profile_id UUID NOT NULL,
  creator_organization_id UUID NOT NULL,
  FOREIGN KEY (creator_profile_id, creator_organization_id) REFERENCES marketplace.creator_profiles(id, organization_id),
  UNIQUE (program_id, creator_profile_id),
  UNIQUE (id, program_id)
);
CREATE TABLE marketplace.affiliate_participation_attempts (
  id UUID PRIMARY KEY,
  participation_id UUID NOT NULL,
  program_id UUID NOT NULL,
  terms_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  origin TEXT NOT NULL CHECK (origin IN ('application', 'invitation')),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (participation_id, attempt_number), UNIQUE (id, terms_id),
  FOREIGN KEY (participation_id, program_id) REFERENCES marketplace.affiliate_participations(id, program_id),
  FOREIGN KEY (terms_id, program_id) REFERENCES marketplace.affiliate_published_terms(id, program_id)
);
CREATE TABLE marketplace.affiliate_assent_decisions (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL,
  terms_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('hotel_approval', 'creator_acceptance')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2),
  -- Exact immutable disclosure remains in affiliate_published_terms; digest alone is not proof.
  disclosure_hash TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (attempt_id, decision), UNIQUE (attempt_id, revision),
  FOREIGN KEY (attempt_id, terms_id) REFERENCES marketplace.affiliate_participation_attempts(id, terms_id),
  FOREIGN KEY (terms_id, disclosure_hash) REFERENCES marketplace.affiliate_published_terms(id, disclosure_hash)
);
CREATE TRIGGER affiliate_participations_immutable BEFORE UPDATE OR DELETE ON marketplace.affiliate_participations
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_participations_no_truncate BEFORE TRUNCATE ON marketplace.affiliate_participations
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_attempts_immutable BEFORE UPDATE OR DELETE ON marketplace.affiliate_participation_attempts
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_attempts_no_truncate BEFORE TRUNCATE ON marketplace.affiliate_participation_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_assent_immutable BEFORE UPDATE OR DELETE ON marketplace.affiliate_assent_decisions
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_assent_no_truncate BEFORE TRUNCATE ON marketplace.affiliate_assent_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
