-- VAY-2442 P5. A vayada Payment payout Vayada sends a hotel by hand (Wise or a bank transfer).
-- Staff start it before any money moves: exactly what is owed for stays checked out by the cut-off
-- (the Sunday before), to the hotel's payout account as it was shown to them. Starting adds a
-- 'payout' row to finance.hotel_payout_ledger (source_key payout:<id>, net −amount), so nobody
-- can pay the same money twice. After sending, staff mark it sent with the transfer reference. A
-- payout never sent (cancelled) or sent back by the bank adds 'payout_returned'
-- (payout_returned:<id>, net +amount): the hotel is owed it again.
-- Test-mode money (livemode false) is paid out only as a test, never mixed with live money.
CREATE TABLE finance.hotel_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  command_id UUID NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  livemode BOOLEAN NOT NULL,
  -- Stays that checked out by this date are paid (the Sunday before the payout).
  cutoff DATE NOT NULL,
  payout_destination_id UUID NOT NULL,
  started_by_user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference TEXT CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 200),
  paid_on DATE,
  sent_by_user_id UUID,
  sent_at TIMESTAMPTZ,
  return_command_id UUID UNIQUE,
  returned_at TIMESTAMPTZ,
  returned_by_user_id UUID,
  return_reason TEXT CHECK (return_reason IS NULL OR length(trim(return_reason)) BETWEEN 1 AND 500),
  FOREIGN KEY (payout_destination_id, property_id)
    REFERENCES finance.payout_destinations(id, property_id),
  CHECK (
    (sent_at IS NULL AND sent_by_user_id IS NULL AND reference IS NULL AND paid_on IS NULL)
    OR (sent_at IS NOT NULL AND sent_by_user_id IS NOT NULL AND reference IS NOT NULL
      AND paid_on IS NOT NULL)
  ),
  CHECK (
    (returned_at IS NULL AND returned_by_user_id IS NULL AND return_command_id IS NULL
      AND return_reason IS NULL)
    OR (returned_at IS NOT NULL AND returned_by_user_id IS NOT NULL
      AND return_command_id IS NOT NULL AND return_reason IS NOT NULL)
  )
);
CREATE INDEX hotel_payouts_property ON finance.hotel_payouts(property_id, started_at DESC);

-- What a payout is never changes. It is marked sent once (only while not cancelled) and returned
-- once; nothing else is ever updated, and nothing is deleted.
CREATE FUNCTION finance.protect_hotel_payout() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (NEW.id, NEW.property_id, NEW.command_id, NEW.currency, NEW.amount_minor, NEW.livemode,
         NEW.cutoff, NEW.payout_destination_id, NEW.started_by_user_id, NEW.started_at)
        IS DISTINCT FROM
        (OLD.id, OLD.property_id, OLD.command_id, OLD.currency, OLD.amount_minor, OLD.livemode,
         OLD.cutoff, OLD.payout_destination_id, OLD.started_by_user_id, OLD.started_at)
     OR (OLD.sent_at IS NOT NULL
         AND (NEW.reference, NEW.paid_on, NEW.sent_by_user_id, NEW.sent_at)
             IS DISTINCT FROM (OLD.reference, OLD.paid_on, OLD.sent_by_user_id, OLD.sent_at))
     OR (OLD.returned_at IS NOT NULL
         AND (NEW.return_command_id, NEW.returned_at, NEW.returned_by_user_id, NEW.return_reason,
              NEW.sent_at)
             IS DISTINCT FROM (OLD.return_command_id, OLD.returned_at, OLD.returned_by_user_id,
              OLD.return_reason, OLD.sent_at))
  THEN
    RAISE EXCEPTION 'hotel payout is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hotel_payout_immutable
BEFORE UPDATE OR DELETE ON finance.hotel_payouts
FOR EACH ROW EXECUTE FUNCTION finance.protect_hotel_payout();
CREATE TRIGGER hotel_payouts_no_truncate
  BEFORE TRUNCATE ON finance.hotel_payouts
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
