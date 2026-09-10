-- VAY-1510: immutable hotel-chosen rates and separate approval evidence.
-- Design: engineering/affiliate-percentage-policy.md
CREATE TABLE finance.affiliate_percentage_policy_versions (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  contract_version TEXT NOT NULL
    CHECK (contract_version = 'finance-affiliate-percentage-policy.v1'),
  model TEXT NOT NULL CHECK (model = 'percentage'),
  revenue_basis TEXT NOT NULL CHECK (revenue_basis = 'accommodation_excluding_taxes_and_extras'),
  eligibility TEXT NOT NULL CHECK (eligibility = 'verified_completion'),
  rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points BETWEEN 0 AND 10000),
  created_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_by_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(recorded_at)),
  CONSTRAINT uq_affiliate_percentage_policy_property UNIQUE (id, property_id)
);

CREATE INDEX idx_affiliate_percentage_policy_property
  ON finance.affiliate_percentage_policy_versions(property_id, recorded_at, id);

CREATE TABLE finance.affiliate_percentage_policy_approvals (
  policy_version_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  approved_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  approved_by_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now() CHECK (isfinite(recorded_at)),
  CONSTRAINT fk_affiliate_percentage_approval_scope
    FOREIGN KEY (policy_version_id, property_id)
    REFERENCES finance.affiliate_percentage_policy_versions(id, property_id)
);

COMMENT ON TABLE finance.affiliate_percentage_policy_approvals IS
  'Approval of the commission component only; does not authorize publication or settlement.';

-- Reuse the established append-only guard for both policy and approval history.
CREATE TRIGGER affiliate_percentage_policy_immutable
  BEFORE UPDATE OR DELETE ON finance.affiliate_percentage_policy_versions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_percentage_policy_no_truncate
  BEFORE TRUNCATE ON finance.affiliate_percentage_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_percentage_approval_immutable
  BEFORE UPDATE OR DELETE ON finance.affiliate_percentage_policy_approvals
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_percentage_approval_no_truncate
  BEFORE TRUNCATE ON finance.affiliate_percentage_policy_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
