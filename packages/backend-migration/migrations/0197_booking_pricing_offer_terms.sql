-- Owner: Booking. Replacement per-offer commercial terms, not payment capability approval.
CREATE TABLE booking.pricing_v2_offer_terms (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id UUID NOT NULL,
  offer_id TEXT NOT NULL CHECK (length(btrim(offer_id)) BETWEEN 1 AND 200),
  revision UUID NOT NULL UNIQUE,
  terms JSONB NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id,room_type_id,offer_id,revision),
  UNIQUE (property_id,request_id),
  CHECK ((jsonb_typeof(terms)='object' AND terms->>'roomTypeId'=room_type_id::text
    AND terms->>'offerId'=offer_id AND terms->>'revision'=revision::text
    AND terms#>>'{cancellation,kind}' IN ('flexible','non_refundable')
    AND terms#>>'{payment,kind}' IN ('full','deposit')) IS TRUE)
);
CREATE TABLE booking.pricing_v2_offer_term_heads (
  property_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  offer_id TEXT NOT NULL,
  revision UUID NOT NULL,
  PRIMARY KEY (property_id,room_type_id,offer_id),
  FOREIGN KEY (property_id,room_type_id,offer_id,revision)
    REFERENCES booking.pricing_v2_offer_terms(property_id,room_type_id,offer_id,revision)
);
CREATE TRIGGER pricing_v2_offer_terms_immutable BEFORE UPDATE OR DELETE ON booking.pricing_v2_offer_terms
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_v2_offer_terms_no_truncate BEFORE TRUNCATE ON booking.pricing_v2_offer_terms
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
