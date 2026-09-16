-- VAY-2019: append-only add-on fulfillment and adjustment evidence for Financials.
CREATE TABLE booking.addon_revenue_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addon_selection_id UUID NOT NULL, property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL, recognized_on DATE NOT NULL,
  quantity INTEGER NOT NULL, currency CHAR(3) NOT NULL,
  gross_amount NUMERIC(19, 4),
  ownership_kind TEXT NOT NULL, partner_commission_rate NUMERIC,
  economic_event TEXT NOT NULL, evidence_quality TEXT NOT NULL,
  source_revision INTEGER NOT NULL, corrects_evidence_id UUID,
  command_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_booking_addon_revenue_command UNIQUE (property_id, command_key),
  CONSTRAINT uq_booking_addon_revenue_revision UNIQUE (addon_selection_id, source_revision),
  CONSTRAINT uq_booking_addon_revenue_scope
    UNIQUE (id, property_id, guest_booking_id, addon_selection_id, currency),
  CONSTRAINT fk_booking_addon_revenue_correction FOREIGN KEY (
    corrects_evidence_id, property_id, guest_booking_id, addon_selection_id, currency
  ) REFERENCES booking.addon_revenue_evidence (
    id, property_id, guest_booking_id, addon_selection_id, currency
  ) ON DELETE RESTRICT,
  CONSTRAINT chk_booking_addon_revenue_dimensions CHECK (
    quantity > 0 AND source_revision BETWEEN 1 AND 2147483647
    AND currency::TEXT ~ '^[A-Z]{3}$'
    AND isfinite(recognized_on)
    AND command_key = btrim(command_key) AND char_length(command_key) BETWEEN 1 AND 200
    AND (corrects_evidence_id IS NULL OR corrects_evidence_id <> id)
  ),
  CONSTRAINT chk_booking_addon_revenue_ownership CHECK (
    (ownership_kind = 'property' AND partner_commission_rate IS NULL)
    OR (ownership_kind = 'partner' AND partner_commission_rate IS NOT NULL
      AND partner_commission_rate BETWEEN 0 AND 100
      AND scale(partner_commission_rate) <= 4)
  ),
  CONSTRAINT chk_booking_addon_revenue_amount CHECK (
    gross_amount IS NULL OR (gross_amount > '-Infinity'::NUMERIC
      AND gross_amount < 'Infinity'::NUMERIC)
  ),
  CONSTRAINT chk_booking_addon_revenue_event CHECK (
    (economic_event = 'fulfillment' AND evidence_quality IN ('exact', 'inferred')
      AND gross_amount IS NOT NULL AND gross_amount >= 0
      AND corrects_evidence_id IS NULL AND source_revision = 1)
    OR (economic_event = 'missing_fulfillment'
      AND evidence_quality IN ('missing', 'conflicting')
      AND gross_amount IS NULL AND corrects_evidence_id IS NULL AND source_revision = 1)
    OR (economic_event = 'refund' AND evidence_quality = 'exact'
      AND gross_amount IS NOT NULL AND gross_amount < 0
      AND corrects_evidence_id IS NOT NULL AND source_revision > 1)
    OR (economic_event = 'correction' AND evidence_quality = 'exact'
      AND gross_amount IS NOT NULL AND gross_amount <> 0
      AND corrects_evidence_id IS NOT NULL AND source_revision > 1)
  )
);
CREATE UNIQUE INDEX uq_booking_addon_revenue_correction_target
  ON booking.addon_revenue_evidence (corrects_evidence_id)
  WHERE corrects_evidence_id IS NOT NULL;
CREATE INDEX idx_booking_addon_revenue_reporting
  ON booking.addon_revenue_evidence (property_id, recognized_on, currency, id);
CREATE FUNCTION booking.validate_addon_revenue_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  purchased booking.booking_addon_selections%ROWTYPE;
  booking_check_in DATE; booking_edit_revision INTEGER;
  target booking.addon_revenue_evidence%ROWTYPE;
  recognized_total NUMERIC;
BEGIN
  SELECT guest.check_in, guest.edit_revision
    INTO booking_check_in, booking_edit_revision
  FROM booking.guest_bookings guest
  WHERE guest.id = NEW.guest_booking_id AND guest.property_id = NEW.property_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Add-on revenue evidence requires the scoped booking'
      USING ERRCODE = '23503', CONSTRAINT = 'fk_booking_addon_revenue_booking';
  END IF;
  IF NEW.source_revision = 1 THEN
    SELECT selection.* INTO purchased FROM booking.booking_addon_selections selection
    WHERE selection.id = NEW.addon_selection_id
      AND selection.property_id = NEW.property_id
      AND selection.guest_booking_id = NEW.guest_booking_id
      AND selection.edit_revision = booking_edit_revision;
  ELSE
    SELECT * INTO purchased FROM booking.booking_addon_selections selection
    WHERE selection.id = NEW.addon_selection_id
      AND selection.property_id = NEW.property_id
      AND selection.guest_booking_id = NEW.guest_booking_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Add-on revenue evidence requires the active purchased selection'
      USING ERRCODE = '23503', CONSTRAINT = 'fk_booking_addon_revenue_active_selection';
  END IF;
  IF ROW(NEW.quantity, NEW.currency, NEW.ownership_kind, NEW.partner_commission_rate)
    IS DISTINCT FROM ROW(purchased.quantity, purchased.currency,
      purchased.ownership_kind_snapshot, purchased.partner_commission_rate_snapshot) THEN
    RAISE EXCEPTION 'Add-on revenue evidence must preserve purchased economics'
      USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_addon_revenue_snapshot';
  END IF;
  IF NEW.economic_event = 'fulfillment' THEN
    IF NEW.gross_amount IS DISTINCT FROM purchased.total_amount
      OR (NEW.evidence_quality = 'exact' AND (purchased.service_date IS NULL
        OR NEW.recognized_on <> purchased.service_date))
      OR (NEW.evidence_quality = 'inferred' AND (purchased.service_date IS NOT NULL
        OR NEW.recognized_on <> booking_check_in)) THEN
      RAISE EXCEPTION 'Add-on fulfillment evidence does not match the purchased selection'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_addon_revenue_fulfillment';
    END IF;
  ELSIF NEW.economic_event = 'missing_fulfillment' THEN
    IF NEW.recognized_on <> COALESCE(purchased.service_date, booking_check_in) THEN
      RAISE EXCEPTION 'Missing add-on fulfillment evidence has an invalid recognition date'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_addon_revenue_missing';
    END IF;
  ELSE
    SELECT * INTO target FROM booking.addon_revenue_evidence evidence
    WHERE evidence.id = NEW.corrects_evidence_id
      AND evidence.property_id = NEW.property_id
      AND evidence.guest_booking_id = NEW.guest_booking_id
      AND evidence.addon_selection_id = NEW.addon_selection_id
      AND evidence.currency = NEW.currency
    FOR UPDATE;
    IF NOT FOUND OR NEW.source_revision <> target.source_revision + 1
      OR NEW.recognized_on < target.recognized_on THEN
      RAISE EXCEPTION 'Add-on adjustment must extend the current evidence chain'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_addon_revenue_chain';
    END IF;
    SELECT COALESCE(sum(evidence.gross_amount), 0) INTO recognized_total
    FROM booking.addon_revenue_evidence evidence
    WHERE evidence.addon_selection_id = NEW.addon_selection_id;
    IF recognized_total + NEW.gross_amount < 0
      OR recognized_total + NEW.gross_amount > purchased.total_amount THEN
      RAISE EXCEPTION 'Add-on adjustment exceeds the purchased gross bounds'
        USING ERRCODE = '23514', CONSTRAINT = 'chk_booking_addon_revenue_balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_booking_addon_revenue_validate
BEFORE INSERT ON booking.addon_revenue_evidence
FOR EACH ROW EXECUTE FUNCTION booking.validate_addon_revenue_evidence();
CREATE FUNCTION booking.protect_addon_revenue_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Add-on revenue evidence is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_booking_addon_revenue_protect_rows
BEFORE UPDATE OR DELETE ON booking.addon_revenue_evidence
FOR EACH ROW EXECUTE FUNCTION booking.protect_addon_revenue_evidence();
CREATE TRIGGER trg_booking_addon_revenue_protect_truncate
BEFORE TRUNCATE ON booking.addon_revenue_evidence
FOR EACH STATEMENT EXECUTE FUNCTION booking.protect_addon_revenue_evidence();
CREATE VIEW booking.finance_addon_revenue_evidence AS
SELECT id AS evidence_id, addon_selection_id, property_id, guest_booking_id,
  recognized_on, quantity, currency, gross_amount, ownership_kind,
  partner_commission_rate, economic_event, evidence_quality, source_revision,
  corrects_evidence_id, created_at
FROM booking.addon_revenue_evidence;
CREATE TRIGGER trg_finance_addon_revenue_read_only
INSTEAD OF INSERT OR UPDATE OR DELETE ON booking.finance_addon_revenue_evidence
FOR EACH ROW EXECUTE FUNCTION booking.protect_addon_revenue_evidence();
