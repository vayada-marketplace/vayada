-- VAY-1092: restrict setup completion stamping to actual setup sessions.
CREATE OR REPLACE FUNCTION platform.guard_hotel_setup_completion_evidence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- pg_has_role treats a superuser as a member of every role. Administrative
  -- writes are not setup commands; preserve their exact audit/replay metadata.
  IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=session_user)
  THEN RETURN NEW; END IF;

  IF NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND session_user::text !~ '^vayada_next_hotel_setup_property_'
  THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (
    SELECT 1 FROM identity.product_entitlements
    WHERE product='pms' AND entitlement_key='module:financials'
      AND resource_product='pms' AND resource_type='pms_property'
      AND lower(resource_id)=OLD.property_id::text
      AND metadata->>'newHotelFinancialsActivationTransaction'=pg_catalog.pg_current_xact_id()::text
    ) THEN
      RAISE EXCEPTION 'Hotel setup completion evidence is sealed' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME <> 'property_pricing_settings' THEN
    NEW := pg_catalog.jsonb_populate_record(NEW, pg_catalog.jsonb_build_object(
      TG_ARGV[0], (pg_catalog.to_jsonb(NEW)->TG_ARGV[0]) ||
        pg_catalog.jsonb_build_object('hotelSetupTransaction', pg_catalog.pg_current_xact_id()::text)
    ));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_hotel_setup_completion_evidence() FROM PUBLIC;
