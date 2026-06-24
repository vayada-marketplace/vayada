CREATE TABLE booking.promo_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  source_system TEXT NOT NULL DEFAULT 'booking' CHECK (source_system IN ('booking', 'migration')),
  source_promo_id TEXT,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(15, 2) NOT NULL CHECK (discount_value > 0),
  currency CHAR(3),
  valid_from DATE,
  valid_until DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_promo_definitions_currency_upper CHECK (currency IS NULL OR currency = upper(currency)),
  CONSTRAINT chk_promo_definitions_date_order CHECK (
    valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from
  ),
  CONSTRAINT chk_promo_definitions_fixed_currency CHECK (
    discount_type <> 'fixed' OR currency IS NOT NULL
  ),
  CONSTRAINT chk_promo_definitions_percentage_value CHECK (
    discount_type <> 'percentage' OR discount_value <= 100
  ),
  CONSTRAINT chk_promo_definitions_source_id CHECK (
    source_system = 'booking' OR source_promo_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX uq_promo_definitions_property_code_active
  ON booking.promo_definitions (property_id, code)
  WHERE status <> 'retired';

CREATE INDEX idx_promo_definitions_property_status
  ON booking.promo_definitions (property_id, status);
