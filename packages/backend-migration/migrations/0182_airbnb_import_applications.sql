-- VAY-1009: receipts for Airbnb sources, separate from invitation redemption.
CREATE TABLE hotel_catalog.airbnb_import_applications (
  source_id UUID PRIMARY KEY REFERENCES hotel_catalog.airbnb_import_sources(id),
  results JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
