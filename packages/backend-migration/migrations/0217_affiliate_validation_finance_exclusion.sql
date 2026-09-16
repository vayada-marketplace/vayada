-- VAY-1506. Diagnostic probe bookings can never become affiliate earning evidence.
-- Advisory locking makes binding and Finance inserts mutually exclusive under concurrency.
CREATE FUNCTION booking.try_affiliate_booking_uuid(value TEXT)
RETURNS UUID LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION booking.prevent_duplicate_affiliate_probe_binding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'affiliate-validation-finance:' || NEW.property_id::text || ':' || NEW.booking_id::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM finance.affiliate_earning_journal earning
    WHERE earning.property_id=NEW.property_id
      AND booking.try_affiliate_booking_uuid(earning.booking_id)=NEW.booking_id
  ) THEN
    RAISE EXCEPTION 'Affiliate validation booking already has earning evidence'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM booking.affiliate_validation_probes probe
  WHERE probe.id = NEW.probe_id
  FOR UPDATE;
  IF FOUND AND EXISTS (
    SELECT 1 FROM booking.affiliate_validation_booking_bindings binding
    WHERE binding.probe_id = NEW.probe_id
  ) THEN
    RAISE EXCEPTION 'Affiliate validation probe already has a booking binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION finance.reject_affiliate_validation_probe_earning()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  booking_uuid UUID;
BEGIN
  booking_uuid := booking.try_affiliate_booking_uuid(NEW.booking_id);
  IF booking_uuid IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'affiliate-validation-finance:' || NEW.property_id::text || ':' || booking_uuid::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM booking.affiliate_validation_booking_bindings binding
    WHERE binding.property_id=NEW.property_id AND binding.booking_id=booking_uuid
  ) THEN
    RAISE EXCEPTION 'Affiliate validation booking cannot create earning evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER affiliate_earning_journal_reject_validation_probe
  BEFORE INSERT ON finance.affiliate_earning_journal
  FOR EACH ROW EXECUTE FUNCTION finance.reject_affiliate_validation_probe_earning();
