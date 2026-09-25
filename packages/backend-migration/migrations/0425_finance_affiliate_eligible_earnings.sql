-- VAY-1511. Trusted input revisions and the immutable handoff consumed by VAY-1514.
CREATE TABLE finance.affiliate_earning_reconciliation_revisions (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  booking_id UUID NOT NULL,
  stay_item_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  calculation_input JSONB NOT NULL CHECK (jsonb_typeof(calculation_input)='object'),
  creator_profile_id UUID NOT NULL,
  affiliate_id TEXT NOT NULL CHECK (length(btrim(affiliate_id)) BETWEEN 1 AND 256),
  beneficiary_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  hotel_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE(property_id,booking_id,stay_item_id,revision),
  UNIQUE(property_id,booking_id,stay_item_id,evidence_digest),
  FOREIGN KEY(booking_id,property_id) REFERENCES booking.guest_bookings(id,property_id),
  FOREIGN KEY(stay_item_id,property_id,booking_id)
    REFERENCES pms.operational_booking_assignments(id,property_id,guest_booking_id),
  FOREIGN KEY(creator_profile_id,beneficiary_organization_id)
    REFERENCES marketplace.creator_profiles(id,organization_id)
);

CREATE TABLE finance.affiliate_eligible_earning_revisions (
  earning_entry_id UUID PRIMARY KEY REFERENCES finance.affiliate_earning_journal(id),
  contract_version TEXT NOT NULL
    CHECK (contract_version='finance-affiliate-settlement-entry.v1'),
  property_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  stay_item_id UUID NOT NULL,
  agreement_id UUID NOT NULL REFERENCES marketplace.affiliate_agreements(id),
  policy_version_id UUID NOT NULL REFERENCES finance.affiliate_percentage_policy_versions(id),
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  creator_profile_id UUID NOT NULL,
  affiliate_id TEXT NOT NULL CHECK (length(btrim(affiliate_id)) BETWEEN 1 AND 256),
  beneficiary_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  currency CHAR(3) NOT NULL CHECK (currency=upper(currency)),
  currency_minor_unit INTEGER NOT NULL CHECK (currency_minor_unit BETWEEN 0 AND 9),
  commission_minor NUMERIC(30,0) NOT NULL CHECK (commission_minor >= 0),
  adjustment_minor NUMERIC(30,0) NOT NULL,
  status TEXT NOT NULL CHECK (status='eligible'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE(property_id,booking_id,stay_item_id,source_revision),
  FOREIGN KEY(creator_profile_id,beneficiary_organization_id)
    REFERENCES marketplace.creator_profiles(id,organization_id)
);

CREATE TRIGGER affiliate_earning_reconciliation_immutable BEFORE UPDATE OR DELETE
  ON finance.affiliate_earning_reconciliation_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_earning_reconciliation_no_truncate BEFORE TRUNCATE
  ON finance.affiliate_earning_reconciliation_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_eligible_earning_immutable BEFORE UPDATE OR DELETE
  ON finance.affiliate_eligible_earning_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_eligible_earning_no_truncate BEFORE TRUNCATE
  ON finance.affiliate_eligible_earning_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
