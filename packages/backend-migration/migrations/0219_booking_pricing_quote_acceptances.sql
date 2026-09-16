-- VAY-1543: immutable replacement acceptance evidence; no acceptance writer/route.
-- Contract: engineering/replacement-booking-acceptance.md. Finance values must
-- come from its authorized owner; these constraints cannot establish provenance.
ALTER TABLE booking.pricing_quotes ADD CONSTRAINT uq_pricing_quotes_owner
  UNIQUE(id,property_id,organization_id);
ALTER TABLE platform.idempotency_keys ADD CONSTRAINT uq_pricing_acceptance_receipt
  UNIQUE(id,property_id,operation_scope,operation,tenant_scope,key_hash,request_fingerprint_hash,status);

CREATE TABLE booking.pricing_quote_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  organization_id UUID NOT NULL,
  pricing_quote_id UUID NOT NULL UNIQUE,
  guest_booking_id UUID NOT NULL UNIQUE,
  command_receipt_id UUID NOT NULL UNIQUE,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200 AND request_id=btrim(request_id)),
  key_hash TEXT NOT NULL CHECK (key_hash=encode(sha256(convert_to(request_id,'UTF8')),'hex')),
  request_fingerprint_hash TEXT NOT NULL CHECK (request_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  receipt_operation_scope TEXT GENERATED ALWAYS AS ('booking'::text) STORED,
  receipt_operation TEXT GENERATED ALWAYS AS ('booking.pricing_quote.accept'::text) STORED,
  receipt_tenant_scope TEXT GENERATED ALWAYS AS ('property'::text) STORED,
  receipt_status TEXT GENERATED ALWAYS AS ('completed'::text) STORED,
  quote_snapshot JSONB NOT NULL CHECK (jsonb_typeof(quote_snapshot)='object'),
  disclosure_json TEXT NOT NULL,
  guest_policy_source_revision TEXT NOT NULL CHECK (length(guest_policy_source_revision) BETWEEN 1 AND 200),
  disclosure_hash TEXT NOT NULL CHECK
    (disclosure_hash='sha256:'||encode(sha256(convert_to(disclosure_json,'UTF8')),'hex')),
  acceptance_command JSONB NOT NULL CHECK (jsonb_typeof(acceptance_command)='object'),
  inventory_reservation_bundle JSONB NOT NULL CHECK (jsonb_typeof(inventory_reservation_bundle)='object'),
  billing_plan_snapshot TEXT NOT NULL CHECK (billing_plan_snapshot IN ('commission','fixed')),
  commission_terms_snapshot JSONB NOT NULL CHECK
    (jsonb_typeof(commission_terms_snapshot)='object' AND commission_terms_snapshot<>'{}'::jsonb),
  finance_terms_captured_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(pricing_quote_id,property_id,organization_id)
    REFERENCES booking.pricing_quotes(id,property_id,organization_id),
  FOREIGN KEY(guest_booking_id,property_id)
    REFERENCES booking.guest_bookings(id,property_id),
  FOREIGN KEY(command_receipt_id,property_id,receipt_operation_scope,receipt_operation,
    receipt_tenant_scope,key_hash,request_fingerprint_hash,receipt_status)
    REFERENCES platform.idempotency_keys(id,property_id,operation_scope,operation,
      tenant_scope,key_hash,request_fingerprint_hash,status),
  CHECK ((quote_snapshot->>'version'='stored-pricing-quote.v1'
    AND quote_snapshot->>'quoteId'=pricing_quote_id::text
    AND quote_snapshot#>>'{stay,propertyId}'=property_id::text) IS TRUE),
  CHECK ((acceptance_command->>'version'='booking-quote-acceptance.v1'
    AND acceptance_command->>'requestId'=request_id
    AND acceptance_command->>'quoteId'=pricing_quote_id::text
    AND acceptance_command#>'{acceptance,accepted}'='true'::jsonb) IS TRUE),
  CHECK ((disclosure_json::jsonb->>'version'='booking.quote-guest-disclosure.v1'
    AND disclosure_json::jsonb->'quote'=quote_snapshot
    AND jsonb_typeof(disclosure_json::jsonb->'choices')='object') IS TRUE),
  CHECK ((inventory_reservation_bundle->>'contractVersion'='pms-inventory-reservation-bundle.v1'
    AND inventory_reservation_bundle->>'owner'='pms'
    AND jsonb_typeof(inventory_reservation_bundle->'receipts')='array'
    AND jsonb_array_length(inventory_reservation_bundle->'receipts')>0) IS TRUE),
  CHECK (finance_terms_captured_at<=accepted_at)
);

-- The immutable quote is the historical price authority, not posted evidence.
CREATE FUNCTION booking.require_pricing_acceptance_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking.pricing_quotes q
    WHERE q.id=NEW.pricing_quote_id AND q.property_id=NEW.property_id
      AND q.organization_id=NEW.organization_id AND q.payload->'quote'=NEW.quote_snapshot) THEN
    RAISE EXCEPTION 'Acceptance must preserve the exact stored pricing quote';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pricing_acceptance_quote BEFORE INSERT ON booking.pricing_quote_acceptances
  FOR EACH ROW EXECUTE FUNCTION booking.require_pricing_acceptance_quote();
CREATE TRIGGER pricing_acceptances_immutable BEFORE UPDATE OR DELETE ON booking.pricing_quote_acceptances
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER pricing_acceptances_no_truncate BEFORE TRUNCATE ON booking.pricing_quote_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
