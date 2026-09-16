-- Provider totals retain their amount basis; never expose them as gross room revenue.
CREATE TABLE finance.airbnb_provider_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  provider_property_id UUID NOT NULL,
  provider_booking_id UUID NOT NULL,
  provider_channel_id UUID NOT NULL,
  provider_revision_id TEXT NOT NULL CHECK (length(provider_revision_id) BETWEEN 1 AND 500),
  provider_revision_at TIMESTAMPTZ NOT NULL CHECK (isfinite(provider_revision_at)),
  settings_evidence_ref TEXT NOT NULL CHECK (length(settings_evidence_ref) BETWEEN 1 AND 500),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_basis TEXT NOT NULL CHECK (amount_basis IN ('Payout Amount','Total Paid Amount')),
  cohost_payout_calculations BOOLEAN,
  provider_booking_amount NUMERIC(19,4) CHECK (provider_booking_amount >= 0),
  ota_commission NUMERIC(19,4) CHECK (ota_commission >= 0),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  CHECK (provider_booking_amount IS NOT NULL OR COALESCE(
    snapshot->>'replacement'='cancellation' AND snapshot->'nights'='[]'::jsonb, FALSE)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id,guest_booking_id,provider_revision_id),
  UNIQUE (property_id,guest_booking_id,provider_revision_at),
  FOREIGN KEY (guest_booking_id,property_id)
    REFERENCES booking.guest_bookings(id,property_id) ON DELETE RESTRICT
);

CREATE FUNCTION finance.protect_airbnb_provider_snapshots() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Airbnb provider snapshots are immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER trg_finance_airbnb_provider_snapshots_rows BEFORE UPDATE OR DELETE
  ON finance.airbnb_provider_snapshots FOR EACH ROW EXECUTE FUNCTION finance.protect_airbnb_provider_snapshots();
CREATE TRIGGER trg_finance_airbnb_provider_snapshots_truncate BEFORE TRUNCATE
  ON finance.airbnb_provider_snapshots FOR EACH STATEMENT EXECUTE FUNCTION finance.protect_airbnb_provider_snapshots();

CREATE VIEW finance.airbnb_current_provider_amounts AS
SELECT DISTINCT ON (property_id,guest_booking_id)
  id AS snapshot_id,property_id,guest_booking_id,provider_property_id,provider_booking_id,
  provider_channel_id,provider_revision_id,provider_revision_at,settings_evidence_ref,
  currency,amount_basis,cohost_payout_calculations,provider_booking_amount,ota_commission,snapshot
FROM finance.airbnb_provider_snapshots
ORDER BY property_id,guest_booking_id,provider_revision_at DESC;

CREATE VIEW finance.airbnb_current_provider_nights AS
SELECT current.snapshot_id,current.property_id,current.guest_booking_id,current.currency,
  current.amount_basis,current.cohost_payout_calculations,
  night."roomTypeId"::uuid AS room_type_id,night."linePosition" AS line_position,
  night."stayDate"::date AS stay_date,night."providerNightlyAmount"::numeric(19,4) AS provider_nightly_amount
FROM finance.airbnb_current_provider_amounts current
CROSS JOIN LATERAL jsonb_to_recordset(current.snapshot->'nights') AS night(
  "roomTypeId" text,"linePosition" integer,"stayDate" text,"providerNightlyAmount" text);

COMMENT ON VIEW finance.airbnb_current_provider_amounts IS
  'Current full replacement provider totals. Commission occurs once per booking; not a generated expense.';
COMMENT ON VIEW finance.airbnb_current_provider_nights IS
  'Provider-allocated nights on the stated payout/guest-paid basis, not gross room revenue.';
