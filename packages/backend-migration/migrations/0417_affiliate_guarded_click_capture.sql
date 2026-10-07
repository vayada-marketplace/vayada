-- VAY-1506. Derive click ownership from the immutable public link and active
-- agreement. The future capture role receives EXECUTE only; it must never
-- receive direct INSERT on affiliate_click_occurrences.
CREATE FUNCTION marketplace.capture_affiliate_click(
  public_token TEXT,
  traffic_source TEXT,
  campaign_label TEXT DEFAULT NULL
)
RETURNS TABLE (
  click_id UUID,
  link_id UUID,
  property_id UUID,
  terms_id UUID,
  reference_token TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected RECORD;
  event RECORD;
  expected_revision INTEGER := 1;
  hotel_paused BOOLEAN := FALSE;
  creator_paused BOOLEAN := FALSE;
  ended BOOLEAN := FALSE;
  generated_click_id UUID := pg_catalog.gen_random_uuid();
  generated_reference TEXT := 'vc_' || pg_catalog.translate(
    pg_catalog.rtrim(
      pg_catalog.encode(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 'base64'),
      '='
    ),
    '+/',
    '-_'
  );
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed'
     OR traffic_source IS NULL
     OR traffic_source NOT IN ('instagram','tiktok','youtube','facebook','x','unknown')
     OR (campaign_label IS NOT NULL AND campaign_label !~
       '^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$') THEN
    RETURN;
  END IF;

  SELECT link.id,link.property_id,activation.terms_id,link.agreement_id
    INTO selected
  FROM marketplace.affiliate_links link
  JOIN marketplace.affiliate_agreement_activations activation
    ON activation.id=link.activation_id AND activation.agreement_id=link.agreement_id
  WHERE link.public_token=capture_affiliate_click.public_token
  FOR SHARE OF activation;
  IF NOT FOUND THEN RETURN; END IF;

  FOR event IN
    SELECT revision,action,actor_side
    FROM marketplace.affiliate_agreement_lifecycle_events
    WHERE agreement_id=selected.agreement_id
    ORDER BY revision
    FOR SHARE
  LOOP
    IF event.revision<>expected_revision OR ended THEN RETURN; END IF;
    expected_revision := expected_revision + 1;
    IF event.action='end' THEN
      ended := TRUE;
    ELSIF event.actor_side='hotel' AND
      ((event.action='pause' AND NOT hotel_paused) OR
       (event.action='resume' AND hotel_paused)) THEN
      hotel_paused := event.action='pause';
    ELSIF event.actor_side='creator' AND
      ((event.action='pause' AND NOT creator_paused) OR
       (event.action='resume' AND creator_paused)) THEN
      creator_paused := event.action='pause';
    ELSE
      RETURN;
    END IF;
  END LOOP;
  IF ended OR hotel_paused OR creator_paused THEN RETURN; END IF;

  RETURN QUERY
  INSERT INTO marketplace.affiliate_click_occurrences
    (id,link_id,property_id,terms_id,reference_token,source,synthetic,campaign_label)
  VALUES (
    generated_click_id,selected.id,selected.property_id,selected.terms_id,
    generated_reference,traffic_source,FALSE,campaign_label
  )
  RETURNING id,affiliate_click_occurrences.link_id,
    affiliate_click_occurrences.property_id,affiliate_click_occurrences.terms_id,
    affiliate_click_occurrences.reference_token;
END
$$;

REVOKE ALL ON FUNCTION marketplace.capture_affiliate_click(TEXT,TEXT,TEXT) FROM PUBLIC;
