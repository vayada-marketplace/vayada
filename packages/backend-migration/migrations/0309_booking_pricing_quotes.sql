CREATE TABLE booking.pricing_quotes (
  id UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(property_id,request_id), UNIQUE(id,property_id),
  CHECK (payload#>>'{quote,quoteId}' IS NOT NULL AND payload#>>'{quote,quoteId}'=id::text),
  CHECK (payload#>>'{quote,stay,propertyId}' IS NOT NULL AND payload#>>'{quote,stay,propertyId}'=property_id::text)
);
CREATE TRIGGER pricing_quotes_immutable BEFORE UPDATE OR DELETE ON booking.pricing_quotes
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_quotes_no_truncate BEFORE TRUNCATE ON booking.pricing_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
