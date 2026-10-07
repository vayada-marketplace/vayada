-- VAY-1506. Permit server-owned live contexts while retaining synthetic fixtures.
-- Public activation remains blocked on separately reviewed least-privilege runtime grants.
ALTER TABLE booking.affiliate_click_contexts
  DROP CONSTRAINT affiliate_click_contexts_synthetic_check;

-- Click evidence is append-only, matching its Booking admission history.
CREATE FUNCTION marketplace.reject_affiliate_click_occurrence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Affiliate click occurrences are immutable'; END;
$$;
DROP TRIGGER affiliate_click_occurrences_no_update
  ON marketplace.affiliate_click_occurrences;
CREATE TRIGGER affiliate_click_occurrences_no_mutation
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_click_occurrences
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_click_occurrence_mutation();
CREATE TRIGGER affiliate_click_occurrences_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_click_occurrences
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_click_occurrence_mutation();
