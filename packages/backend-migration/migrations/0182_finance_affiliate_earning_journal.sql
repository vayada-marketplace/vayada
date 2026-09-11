-- VAY-1510. Calculation history only; no payout or balance authorization.
-- Design: engineering/affiliate-earning-journal.md
CREATE TABLE finance.affiliate_earning_journal (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  booking_id TEXT NOT NULL CHECK (booking_id ~ '^[A-Za-z0-9_-]{1,256}$'),
  stay_item_id TEXT NOT NULL CHECK (stay_item_id ~ '^[A-Za-z0-9_-]{1,256}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  calculation_input JSONB NOT NULL CHECK (jsonb_typeof(calculation_input) = 'object'),
  outcome JSONB NOT NULL CHECK (outcome->>'status' IS NOT NULL AND outcome->>'status' IN ('calculated','pending','needs_review')),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (property_id, booking_id, stay_item_id, revision),
  UNIQUE (property_id, booking_id, stay_item_id, source_revision)
);
CREATE TRIGGER affiliate_earning_journal_immutable
  BEFORE UPDATE OR DELETE ON finance.affiliate_earning_journal
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_earning_journal_no_truncate
  BEFORE TRUNCATE ON finance.affiliate_earning_journal
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
