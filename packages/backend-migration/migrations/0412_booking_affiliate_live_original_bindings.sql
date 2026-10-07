-- VAY-1508. Admit live Booking-owned contexts while keeping synthetic earnings excluded.
ALTER TABLE booking.affiliate_original_booking_bindings
  DROP CONSTRAINT affiliate_original_booking_bindings_synthetic_check;

ALTER TABLE booking.affiliate_click_contexts
  ADD CONSTRAINT uq_affiliate_context_property_synthetic UNIQUE (id, property_id, synthetic);
ALTER TABLE booking.affiliate_original_booking_bindings
  ADD CONSTRAINT fk_affiliate_binding_context_kind
  FOREIGN KEY (context_id, property_id, synthetic)
    REFERENCES booking.affiliate_click_contexts(id, property_id, synthetic);

CREATE OR REPLACE FUNCTION booking.reject_synthetic_binding_with_earning()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.synthetic THEN
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
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION finance.reject_synthetic_original_booking_earning()
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
      AND binding.synthetic=TRUE
  ) THEN
    RAISE EXCEPTION 'Synthetic affiliate booking cannot create earning evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;
