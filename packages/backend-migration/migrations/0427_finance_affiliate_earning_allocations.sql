-- VAY-1514. Idempotent handoff from eligible affiliate earning revisions to Finance payouts.
-- Contract: https://linear.app/vayadacom/document/affiliate-earning-to-payout-handoff-v1-e55f181bdd08
CREATE TABLE finance.affiliate_earning_allocations (
  earning_entry_id UUID PRIMARY KEY,
  entry_digest TEXT NOT NULL CHECK (entry_digest ~ '^[0-9a-f]{64}$'),
  entry_snapshot JSONB NOT NULL CHECK (
    entry_snapshot->>'contractVersion' = 'finance-affiliate-settlement-entry.v1'
  ),
  creator_profile_id TEXT NOT NULL,
  affiliate_id TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  booking_id TEXT NOT NULL,
  stay_item_id TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
  currency_minor_unit SMALLINT NOT NULL CHECK (currency_minor_unit BETWEEN 0 AND 9),
  commission_minor NUMERIC(30, 0) NOT NULL CHECK (commission_minor >= 0),
  adjustment_minor NUMERIC(30, 0) NOT NULL,
  unapplied_minor NUMERIC(30, 0) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('processing', 'blocked', 'allocated', 'correction_review')),
  blocker TEXT,
  recorded_at TIMESTAMPTZ NOT NULL CHECK (isfinite(recorded_at)),
  allocated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'blocked') = (blocker IS NOT NULL)),
  CHECK (status <> 'allocated' OR unapplied_minor = 0)
);

CREATE TABLE finance.affiliate_earning_allocation_items (
  earning_entry_id UUID NOT NULL REFERENCES finance.affiliate_earning_allocations(earning_entry_id),
  payout_id UUID NOT NULL REFERENCES finance.payouts(id),
  applied_minor NUMERIC(30, 0) NOT NULL CHECK (applied_minor <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (earning_entry_id, payout_id)
);

CREATE INDEX idx_finance_affiliate_allocations_reconciliation
  ON finance.affiliate_earning_allocations (affiliate_id, currency, recorded_at);

CREATE FUNCTION finance.guard_affiliate_earning_allocation_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'affiliate earning allocation evidence is immutable';
  END IF;
  IF ROW(
    NEW.earning_entry_id, NEW.entry_digest, NEW.entry_snapshot, NEW.creator_profile_id,
    NEW.affiliate_id, NEW.organization_id, NEW.property_id, NEW.booking_id,
    NEW.stay_item_id, NEW.agreement_id, NEW.policy_version_id, NEW.source_revision,
    NEW.currency, NEW.currency_minor_unit, NEW.commission_minor, NEW.adjustment_minor,
    NEW.recorded_at
  ) IS DISTINCT FROM ROW(
    OLD.earning_entry_id, OLD.entry_digest, OLD.entry_snapshot, OLD.creator_profile_id,
    OLD.affiliate_id, OLD.organization_id, OLD.property_id, OLD.booking_id,
    OLD.stay_item_id, OLD.agreement_id, OLD.policy_version_id, OLD.source_revision,
    OLD.currency, OLD.currency_minor_unit, OLD.commission_minor, OLD.adjustment_minor,
    OLD.recorded_at
  ) THEN
    RAISE EXCEPTION 'affiliate earning allocation evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finance_affiliate_allocations_evidence_immutable
  BEFORE UPDATE OR DELETE ON finance.affiliate_earning_allocations
  FOR EACH ROW EXECUTE FUNCTION finance.guard_affiliate_earning_allocation_evidence();

CREATE TRIGGER finance_affiliate_allocations_no_truncate
  BEFORE TRUNCATE ON finance.affiliate_earning_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER finance_affiliate_allocation_items_immutable
  BEFORE UPDATE OR DELETE ON finance.affiliate_earning_allocation_items
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();

CREATE TRIGGER finance_affiliate_allocation_items_no_truncate
  BEFORE TRUNCATE ON finance.affiliate_earning_allocation_items
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
