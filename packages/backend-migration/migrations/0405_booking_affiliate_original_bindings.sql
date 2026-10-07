-- VAY-1508. Synthetic original-booking binding; live checkout is not wired yet.
CREATE TABLE booking.affiliate_original_booking_bindings (
  booking_id UUID PRIMARY KEY,
  property_id UUID NOT NULL,
  context_id UUID NOT NULL,
  history_cutoff BIGINT NOT NULL CHECK (history_cutoff >= 0),
  original_public_reference TEXT NOT NULL,
  original_check_in DATE NOT NULL,
  original_check_out DATE NOT NULL CHECK (original_check_out > original_check_in),
  original_currency CHAR(3) NOT NULL,
  synthetic BOOLEAN NOT NULL CHECK (synthetic),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(bound_at)),
  FOREIGN KEY (booking_id, property_id)
    REFERENCES booking.guest_bookings(id, property_id),
  FOREIGN KEY (context_id, property_id)
    REFERENCES booking.affiliate_click_contexts(id, property_id)
);

CREATE FUNCTION booking.reject_affiliate_original_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Original affiliate booking binding is immutable'; END;
$$;
CREATE TRIGGER affiliate_original_booking_bindings_no_mutation
  BEFORE UPDATE OR DELETE ON booking.affiliate_original_booking_bindings
  FOR EACH ROW EXECUTE FUNCTION booking.reject_affiliate_original_binding_mutation();
CREATE TRIGGER affiliate_original_booking_bindings_no_truncate
  BEFORE TRUNCATE ON booking.affiliate_original_booking_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION booking.reject_affiliate_original_binding_mutation();

-- Synthetic reservations are excluded from earnings even if a future resolver is added.
-- Use the existing per-booking advisory key so binding and Finance inserts serialize.
CREATE FUNCTION booking.reject_synthetic_binding_with_earning()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'affiliate-validation-finance:' || NEW.property_id::text || ':' || NEW.booking_id::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM finance.affiliate_earning_journal earning
    WHERE earning.property_id=NEW.property_id
      AND booking.try_affiliate_booking_uuid(earning.booking_id)=NEW.booking_id
  ) THEN
    RAISE EXCEPTION 'Synthetic affiliate booking cannot have earning evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER affiliate_original_booking_binding_reject_earning
  BEFORE INSERT ON booking.affiliate_original_booking_bindings
  FOR EACH ROW EXECUTE FUNCTION booking.reject_synthetic_binding_with_earning();

CREATE FUNCTION finance.reject_synthetic_original_booking_earning()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking_uuid UUID;
BEGIN
  booking_uuid := booking.try_affiliate_booking_uuid(NEW.booking_id);
  IF booking_uuid IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'affiliate-validation-finance:' || NEW.property_id::text || ':' || booking_uuid::text, 0
  ));
  IF EXISTS (
    SELECT 1 FROM booking.affiliate_original_booking_bindings binding
    WHERE binding.property_id=NEW.property_id AND binding.booking_id=booking_uuid
  ) THEN
    RAISE EXCEPTION 'Synthetic affiliate booking cannot create earning evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER affiliate_earning_journal_reject_synthetic_original
  BEFORE INSERT ON finance.affiliate_earning_journal
  FOR EACH ROW EXECUTE FUNCTION finance.reject_synthetic_original_booking_earning();
