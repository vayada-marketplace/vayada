-- VAY-1506. Server-issued click occurrences; no public capture route is enabled.
CREATE TABLE marketplace.affiliate_click_occurrences (
  id UUID PRIMARY KEY,
  link_id UUID NOT NULL,
  property_id UUID NOT NULL,
  terms_id UUID NOT NULL REFERENCES marketplace.affiliate_published_terms(id),
  reference_token TEXT NOT NULL UNIQUE CHECK (reference_token ~ '^vc_[A-Za-z0-9_-]{22}$'),
  source TEXT NOT NULL CHECK (source IN ('instagram', 'tiktok', 'youtube', 'facebook', 'x', 'unknown')),
  synthetic BOOLEAN NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(clicked_at)),
  FOREIGN KEY (link_id, property_id) REFERENCES marketplace.affiliate_links(id, property_id)
);

CREATE INDEX affiliate_click_occurrences_link_time
  ON marketplace.affiliate_click_occurrences(link_id, clicked_at DESC);

CREATE TRIGGER affiliate_click_occurrences_no_update
  BEFORE UPDATE ON marketplace.affiliate_click_occurrences
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
