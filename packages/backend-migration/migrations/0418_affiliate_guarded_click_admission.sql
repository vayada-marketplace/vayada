-- VAY-1506. Admit a captured live click without granting direct INSERT on
-- Booking-owned contexts or admission history.
CREATE FUNCTION booking.admit_affiliate_click(
  reference_token TEXT,
  expected_property_id UUID,
  existing_context_id UUID DEFAULT NULL
)
RETURNS TABLE (
  status TEXT,
  context_id UUID,
  context_created BOOLEAN,
  click_id UUID,
  history_position BIGINT,
  replayed BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected RECORD;
  prior RECORD;
  selected_context_id UUID;
  selected_history_position BIGINT;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
     OR reference_token IS NULL
     OR reference_token !~ '^vc_[A-Za-z0-9_-]{22}$'
     OR expected_property_id IS NULL THEN
    RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
    RETURN;
  END IF;

  -- The click row is immutable, but this exclusive lock serializes competing
  -- deliveries of the same one-time transport reference.
  SELECT occurrence.id,occurrence.property_id,occurrence.clicked_at
    INTO selected
  FROM marketplace.affiliate_click_occurrences occurrence
  WHERE occurrence.reference_token=admit_affiliate_click.reference_token
    AND occurrence.synthetic=FALSE
    AND occurrence.property_id=expected_property_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
    RETURN;
  END IF;

  SELECT admission.context_id,admission.history_position
    INTO prior
  FROM booking.affiliate_click_admissions admission
  WHERE admission.click_id=selected.id;
  IF FOUND THEN
    IF existing_context_id IS NOT NULL AND prior.context_id=existing_context_id THEN
      RETURN QUERY SELECT
        'admitted',prior.context_id,FALSE,selected.id,prior.history_position,TRUE;
    ELSE
      RETURN QUERY SELECT 'conflict',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
    END IF;
    RETURN;
  END IF;

  IF selected.clicked_at <= pg_catalog.clock_timestamp() - interval '15 minutes' THEN
    RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
    RETURN;
  END IF;

  IF existing_context_id IS NULL THEN
    selected_context_id := pg_catalog.gen_random_uuid();
    BEGIN
      INSERT INTO booking.affiliate_click_contexts(id,property_id,synthetic)
      VALUES (selected_context_id,expected_property_id,FALSE);
      -- The foreign-key check above can wait on a property-row lock. Roll the
      -- new context back if its one-time transport reference expires meanwhile.
      IF selected.clicked_at <= pg_catalog.clock_timestamp() - interval '15 minutes' THEN
        RAISE EXCEPTION 'Affiliate reference expired while creating context'
          USING ERRCODE='VY001';
      END IF;
    EXCEPTION WHEN SQLSTATE 'VY001' THEN
      RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
      RETURN;
    END;
  ELSE
    selected_context_id := existing_context_id;
    PERFORM 1
    FROM booking.affiliate_click_contexts context
    WHERE context.id=selected_context_id
      AND context.property_id=expected_property_id
      AND context.synthetic=FALSE
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
      RETURN;
    END IF;
    -- Recheck after the context-lock wait so an expired reference cannot enter
    -- otherwise valid history.
    IF selected.clicked_at <= pg_catalog.clock_timestamp() - interval '15 minutes' THEN
      RETURN QUERY SELECT 'unavailable',NULL::UUID,FALSE,NULL::UUID,NULL::BIGINT,FALSE;
      RETURN;
    END IF;
  END IF;

  SELECT COALESCE(pg_catalog.max(admission.history_position),0::BIGINT)+1
    INTO selected_history_position
  FROM booking.affiliate_click_admissions admission
  WHERE admission.context_id=selected_context_id;

  INSERT INTO booking.affiliate_click_admissions
    (context_id,property_id,click_id,history_position)
  VALUES (selected_context_id,expected_property_id,selected.id,selected_history_position);

  RETURN QUERY SELECT
    'admitted',selected_context_id,existing_context_id IS NULL,
    selected.id,selected_history_position,FALSE;
END
$$;

REVOKE ALL ON FUNCTION booking.admit_affiliate_click(TEXT,UUID,UUID) FROM PUBLIC;
