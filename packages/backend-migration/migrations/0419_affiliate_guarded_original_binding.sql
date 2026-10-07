-- VAY-1508. Prove that a live affiliate binding is written in the original
-- booking-creation transaction and derive every stored booking field in SQL.
ALTER TABLE booking.guest_bookings
  ADD COLUMN affiliate_binding_created_xid XID8;
ALTER TABLE booking.guest_bookings
  ALTER COLUMN affiliate_binding_created_xid SET DEFAULT pg_current_xact_id();

CREATE FUNCTION booking.reject_affiliate_booking_creation_xid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Affiliate booking creation transaction is immutable'; END;
$$;
CREATE TRIGGER guest_bookings_affiliate_creation_xid_no_update
  BEFORE UPDATE OF affiliate_binding_created_xid ON booking.guest_bookings
  FOR EACH ROW EXECUTE FUNCTION booking.reject_affiliate_booking_creation_xid_mutation();

CREATE FUNCTION booking.bind_live_affiliate_original(
  selected_booking_id UUID,
  selected_context_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_booking RECORD;
  selected_cutoff BIGINT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
     OR selected_booking_id IS NULL OR selected_context_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT booking.property_id,booking.public_reference,booking.check_in,
         booking.check_out,booking.currency
    INTO selected_booking
  FROM booking.guest_bookings booking
  WHERE booking.id=selected_booking_id
    AND booking.affiliate_binding_created_xid=pg_catalog.pg_current_xact_id()
    -- xmin stores the 32-bit row-creating xid. The explicit xid8 cast remains
    -- correct after epoch wrap. Native callers insert outside active savepoints
    -- so xmin is the same top-level transaction recorded by the default.
    AND booking.xmin=pg_catalog.pg_current_xact_id()::xid
  FOR SHARE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1
  FROM booking.affiliate_click_contexts context
  WHERE context.id=selected_context_id
    AND context.property_id=selected_booking.property_id
    AND context.synthetic=FALSE
  FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1
  FROM booking.affiliate_click_admissions admission
  WHERE admission.context_id=selected_context_id
    AND admission.admitted_at > pg_catalog.clock_timestamp() - interval '90 days'
  LIMIT 1;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT pg_catalog.max(admission.history_position)
    INTO selected_cutoff
  FROM booking.affiliate_click_admissions admission
  WHERE admission.context_id=selected_context_id;

  INSERT INTO booking.affiliate_original_booking_bindings
    (booking_id,property_id,context_id,history_cutoff,
     original_public_reference,original_check_in,original_check_out,original_currency,synthetic)
  VALUES (
    selected_booking_id,selected_booking.property_id,selected_context_id,selected_cutoff,
    selected_booking.public_reference,selected_booking.check_in,selected_booking.check_out,
    selected_booking.currency,FALSE
  );
  RETURN TRUE;
END
$$;

REVOKE ALL ON FUNCTION booking.bind_live_affiliate_original(UUID,UUID) FROM PUBLIC;
