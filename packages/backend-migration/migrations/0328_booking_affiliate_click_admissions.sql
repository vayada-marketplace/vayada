-- VAY-1506. Synthetic destination admission only; no guest context cookie or public route.
CREATE TABLE booking.affiliate_click_contexts (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  synthetic BOOLEAN NOT NULL CHECK (synthetic),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  UNIQUE (id, property_id)
);

CREATE TABLE booking.affiliate_click_admissions (
  context_id UUID NOT NULL,
  property_id UUID NOT NULL,
  click_id UUID NOT NULL UNIQUE,
  history_position BIGINT NOT NULL CHECK (history_position > 0),
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(admitted_at)),
  PRIMARY KEY (context_id, history_position),
  FOREIGN KEY (context_id, property_id)
    REFERENCES booking.affiliate_click_contexts(id, property_id)
);

CREATE FUNCTION booking.reject_affiliate_click_context_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Affiliate click context history is immutable'; END;
$$;
CREATE TRIGGER affiliate_click_contexts_no_update
  BEFORE UPDATE OR DELETE ON booking.affiliate_click_contexts
  FOR EACH ROW EXECUTE FUNCTION booking.reject_affiliate_click_context_mutation();
CREATE TRIGGER affiliate_click_contexts_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_click_contexts
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_affiliate_click_context_mutation();
CREATE TRIGGER affiliate_click_admissions_no_update
  BEFORE UPDATE OR DELETE ON booking.affiliate_click_admissions
  FOR EACH ROW EXECUTE FUNCTION booking.reject_affiliate_click_context_mutation();
CREATE TRIGGER affiliate_click_admissions_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_click_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_affiliate_click_context_mutation();
