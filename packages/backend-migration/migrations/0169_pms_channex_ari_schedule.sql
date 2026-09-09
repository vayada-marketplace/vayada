-- VAY-1527: retain observed transitions, including changes back to an old price.
CREATE TABLE pms.channex_ari_schedule_sources (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  fingerprint TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)
);
