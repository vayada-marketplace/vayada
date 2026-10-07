-- VAY-1506. Bound persisted affiliate clicks per public link across every API
-- instance. The quota stores no visitor address or fingerprint.
CREATE TABLE marketplace.affiliate_click_quota_windows (
  link_id UUID PRIMARY KEY
    REFERENCES marketplace.affiliate_links(id),
  window_started_at TIMESTAMPTZ NOT NULL,
  consumed INTEGER NOT NULL CHECK (consumed BETWEEN 1 AND 3000)
);

REVOKE ALL ON marketplace.affiliate_click_quota_windows FROM PUBLIC;

CREATE FUNCTION marketplace.consume_affiliate_click_quota(input_public_token TEXT)
RETURNS TABLE (allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_link_id UUID;
  current_window TIMESTAMPTZ := pg_catalog.date_trunc('minute', pg_catalog.statement_timestamp());
  active_window TIMESTAMPTZ;
BEGIN
  SELECT link.id INTO selected_link_id
  FROM marketplace.affiliate_links link
  WHERE link.public_token=input_public_token;

  -- Preserve the public route's 404 behavior without writing quota state for
  -- random, valid-shaped tokens.
  IF NOT FOUND THEN
    RETURN QUERY SELECT TRUE, NULL::INTEGER;
    RETURN;
  END IF;

  INSERT INTO marketplace.affiliate_click_quota_windows
    (link_id,window_started_at,consumed)
  VALUES (selected_link_id,current_window,1)
  ON CONFLICT (link_id) DO UPDATE SET
    window_started_at=CASE
      WHEN affiliate_click_quota_windows.window_started_at<current_window
        THEN current_window
      ELSE affiliate_click_quota_windows.window_started_at
    END,
    consumed=CASE
      WHEN affiliate_click_quota_windows.window_started_at<current_window THEN 1
      ELSE affiliate_click_quota_windows.consumed+1
    END
  WHERE affiliate_click_quota_windows.window_started_at<current_window
     OR affiliate_click_quota_windows.consumed<3000
  RETURNING affiliate_click_quota_windows.window_started_at INTO active_window;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT window_started_at INTO active_window
  FROM marketplace.affiliate_click_quota_windows
  WHERE link_id=selected_link_id;
  RETURN QUERY SELECT FALSE, CASE
    WHEN active_window + INTERVAL '1 minute' - pg_catalog.statement_timestamp()
      <= INTERVAL '1 second' THEN 1
    ELSE pg_catalog.ceil(pg_catalog.date_part(
      'epoch', active_window + INTERVAL '1 minute' - pg_catalog.statement_timestamp()
    ))::INTEGER
  END;
END
$$;

REVOKE ALL ON FUNCTION marketplace.consume_affiliate_click_quota(TEXT) FROM PUBLIC;
