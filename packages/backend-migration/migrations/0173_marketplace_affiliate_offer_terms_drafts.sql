-- VAY-1501: append-only drafts; no publication or earning eligibility.
-- Design: engineering/marketplace-affiliate-offer-terms.md
CREATE TABLE marketplace.affiliate_offer_terms_drafts (
  id UUID PRIMARY KEY,
  offer_id UUID NOT NULL,
  property_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  contract_version TEXT NOT NULL
    CHECK (contract_version = 'marketplace-affiliate-offer-terms.v1'),
  booking_destination_id TEXT NOT NULL
    CHECK (length(booking_destination_id) BETWEEN 1 AND 256
      AND booking_destination_id ~ '^[A-Za-z0-9_-]+$'),
  finance_policy_version_id TEXT NOT NULL
    CHECK (length(finance_policy_version_id) BETWEEN 1 AND 256
      AND finance_policy_version_id ~ '^[A-Za-z0-9_-]+$'),
  -- Same exact-integer-millisecond bound as the domain draft parser.
  attribution_window_days INTEGER NOT NULL
    CHECK (attribution_window_days BETWEEN 1 AND 104249991),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(recorded_at)),
  CONSTRAINT uq_affiliate_offer_draft_revision UNIQUE (offer_id, revision),
  CONSTRAINT fk_affiliate_offer_draft_scope
    FOREIGN KEY (offer_id, property_id, organization_id)
    REFERENCES marketplace.marketplace_offers(id, property_id, organization_id)
);

COMMENT ON TABLE marketplace.affiliate_offer_terms_drafts IS
  'Unapproved draft revisions only. External references require owner-domain resolution before publication.';

CREATE FUNCTION marketplace.reject_affiliate_offer_draft_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Affiliate offer drafts are append-only; insert a new revision'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER affiliate_offer_drafts_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_offer_terms_drafts
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();

CREATE TRIGGER affiliate_offer_drafts_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_offer_terms_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
