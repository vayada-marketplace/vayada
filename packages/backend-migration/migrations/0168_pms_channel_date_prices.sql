-- VAY-1527: explicit room-night prices for channel distribution. Null removes a
-- price while retaining its revision so stale edits cannot resurrect it.
CREATE TABLE pms.channel_date_prices (
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  room_type_id UUID NOT NULL,
  rate_plan_id UUID NOT NULL,
  stay_date DATE NOT NULL,
  amount NUMERIC(15,2) CHECK (amount > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  command_id UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_plan_id, stay_date),
  FOREIGN KEY (rate_plan_id, property_id, room_type_id)
    REFERENCES pms.rate_plans(id, property_id, room_type_id) ON DELETE CASCADE
);
CREATE INDEX channel_date_prices_property ON pms.channel_date_prices(property_id);
