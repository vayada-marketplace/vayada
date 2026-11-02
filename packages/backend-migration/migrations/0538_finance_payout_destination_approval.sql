-- VAY-2442 P7. Vayada staff approve a hotel's payout account before any payout goes to it
-- (Flamur, 2026-11-02): an owner who replaces the account, or someone with a stolen owner login,
-- can't redirect money until staff have checked the new account. Card payments keep working
-- meanwhile. The approval is a stamp on the account's revision: staff's "Approve bank account"
-- (approved_via 'payout_account'), or the hotel's first card approval for its first account
-- ('card_approval'). It is set once, only while that revision is the account in use, never at
-- insert, and never changed or removed after; a replacement is a new revision without one.
ALTER TABLE finance.payout_destinations
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN approved_by_user_id UUID,
  ADD COLUMN approved_via TEXT CHECK (approved_via IN ('payout_account', 'card_approval')),
  ADD CONSTRAINT payout_destination_approval_complete CHECK (
    (approved_at IS NULL AND approved_by_user_id IS NULL AND approved_via IS NULL)
    OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_via IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION finance.protect_payout_destination_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.property_id, NEW.revision, NEW.key_arn, NEW.account_last4, NEW.country_code)
       IS DISTINCT FROM
     (OLD.id, OLD.property_id, OLD.revision, OLD.key_arn, OLD.account_last4, OLD.country_code)
     OR (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext AND NEW.ciphertext IS NOT NULL)
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
     OR (NOT OLD.enabled AND NEW.enabled)
     -- Approved once, and only while this revision is the account in use.
     OR (OLD.approved_at IS NOT NULL
         AND (NEW.approved_at, NEW.approved_by_user_id, NEW.approved_via)
             IS DISTINCT FROM (OLD.approved_at, OLD.approved_by_user_id, OLD.approved_via))
     OR (OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
         AND NOT (OLD.enabled AND OLD.deleted_at IS NULL AND NEW.enabled AND NEW.deleted_at IS NULL))
  THEN
    RAISE EXCEPTION 'payout destination revision is immutable' USING ERRCODE = '55000';
  END IF;
  -- The approval's time is when it was recorded, never one chosen by the writer.
  IF OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL THEN
    NEW.approved_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION finance.payout_destination_starts_unapproved() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_at IS NOT NULL OR NEW.approved_by_user_id IS NOT NULL
     OR NEW.approved_via IS NOT NULL THEN
    RAISE EXCEPTION 'a new payout account is approved after it is saved' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_destination_starts_unapproved
BEFORE INSERT ON finance.payout_destinations
FOR EACH ROW EXECUTE FUNCTION finance.payout_destination_starts_unapproved();
