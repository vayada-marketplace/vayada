-- VAY-2442 P1. Where vayada Payment pays a hotel out: the hotel's own bank account, encrypted
-- like 0151's bank-transfer destination (KMS purpose finance-payout-destination-v1). Only the
-- latest revision keeps ciphertext; a replacement or a removal wipes the one before it.
CREATE TABLE finance.payout_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state_version INTEGER NOT NULL CHECK (state_version > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ciphertext BYTEA,
  key_arn TEXT NOT NULL,
  account_last4 TEXT NOT NULL CHECK (account_last4 ~ '^[A-Za-z0-9]{4}$'),
  country_code CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (property_id, revision),
  UNIQUE (id, property_id),
  CHECK ((deleted_at IS NULL AND ciphertext IS NOT NULL
          AND octet_length(ciphertext) BETWEEN 29 AND 6144)
      OR (deleted_at IS NOT NULL AND ciphertext IS NULL AND NOT enabled))
);
CREATE UNIQUE INDEX payout_destination_active
  ON finance.payout_destinations(property_id) WHERE enabled;

CREATE FUNCTION finance.protect_payout_destination_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.property_id, NEW.revision, NEW.key_arn, NEW.account_last4, NEW.country_code)
       IS DISTINCT FROM
     (OLD.id, OLD.property_id, OLD.revision, OLD.key_arn, OLD.account_last4, OLD.country_code)
     OR (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext AND NEW.ciphertext IS NOT NULL)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (NOT OLD.enabled AND NEW.enabled)
  THEN
    RAISE EXCEPTION 'payout destination revision is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_destination_revision_immutable
BEFORE UPDATE ON finance.payout_destinations
FOR EACH ROW EXECUTE FUNCTION finance.protect_payout_destination_revision();
