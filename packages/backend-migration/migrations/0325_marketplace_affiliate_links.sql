-- VAY-1504. One immutable canonical public link per activated affiliate agreement.
-- Campaign labels are request metadata and never stored as link ownership.
ALTER TABLE marketplace.affiliate_agreements
  ADD CONSTRAINT uq_affiliate_agreement_link_scope
  UNIQUE USING INDEX uq_affiliate_agreement_link_scope;

ALTER TABLE marketplace.affiliate_agreement_activations
  ADD CONSTRAINT uq_affiliate_activation_link_scope
  UNIQUE USING INDEX uq_affiliate_activation_link_scope;

CREATE TABLE marketplace.affiliate_links (
  id UUID PRIMARY KEY,
  agreement_id UUID NOT NULL UNIQUE,
  activation_id UUID NOT NULL UNIQUE,
  participation_id UUID NOT NULL,
  program_id UUID NOT NULL,
  property_id UUID NOT NULL,
  public_token TEXT NOT NULL UNIQUE
    CHECK (public_token ~ '^va_[A-Za-z0-9_-]{22}$'),
  contract_version TEXT NOT NULL
    CHECK (contract_version = 'marketplace-affiliate-link.v1'),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  UNIQUE (id, property_id),
  FOREIGN KEY (agreement_id, participation_id, program_id, property_id)
    REFERENCES marketplace.affiliate_agreements(id, participation_id, program_id, property_id),
  FOREIGN KEY (activation_id, agreement_id)
    REFERENCES marketplace.affiliate_agreement_activations(id, agreement_id)
);

CREATE TRIGGER affiliate_links_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_links
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();

CREATE TRIGGER affiliate_links_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_links
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
