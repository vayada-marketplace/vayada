-- Booking-owned inert draft membership. Staging never advances an active head.
CREATE TABLE booking.pricing_v2_offer_term_candidates (
  property_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  offer_id TEXT NOT NULL,
  revision UUID NOT NULL PRIMARY KEY,
  draft_id UUID NOT NULL,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0 AND base_revision < 2147483647),
  expected_revision UUID,
  FOREIGN KEY (property_id,room_type_id,offer_id,revision)
    REFERENCES booking.pricing_v2_offer_terms(property_id,room_type_id,offer_id,revision),
  FOREIGN KEY (property_id,room_type_id,offer_id,expected_revision)
    REFERENCES booking.pricing_v2_offer_terms(property_id,room_type_id,offer_id,revision)
);
CREATE TRIGGER pricing_v2_offer_term_candidates_immutable BEFORE UPDATE OR DELETE ON booking.pricing_v2_offer_term_candidates
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_v2_offer_term_candidates_no_truncate BEFORE TRUNCATE ON booking.pricing_v2_offer_term_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
