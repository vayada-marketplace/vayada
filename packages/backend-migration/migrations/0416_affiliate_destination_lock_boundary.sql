-- VAY-1508. Let the future capture role hold destination rows stable without
-- allowing arbitrary SQL through that role to change the hotel catalogue.
-- Grants and live capture remain separate release gates.

-- hotel_catalog.properties already has RLS from the Finance worker boundary.
CREATE POLICY affiliate_capture_destination_lock_only
  ON hotel_catalog.properties AS RESTRICTIVE FOR UPDATE TO PUBLIC
  USING (true)
  WITH CHECK (current_user <> 'vayada_next_affiliate_capture');

-- Preserve existing callers when introducing RLS to the slug table. The
-- restrictive policy affects only the future affiliate capture login.
ALTER TABLE hotel_catalog.property_slugs ENABLE ROW LEVEL SECURITY;
CREATE POLICY affiliate_capture_compat
  ON hotel_catalog.property_slugs TO PUBLIC USING (true);
CREATE POLICY affiliate_capture_destination_lock_only
  ON hotel_catalog.property_slugs AS RESTRICTIVE FOR UPDATE TO PUBLIC
  USING (true)
  WITH CHECK (current_user <> 'vayada_next_affiliate_capture');
