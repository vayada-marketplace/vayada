-- VAY-1557 / VAY-1540. New storage only; no runtime or legacy data migration.
CREATE TABLE pms.pricing_v2_heads (
  property_id UUID PRIMARY KEY REFERENCES hotel_catalog.properties(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE pms.pricing_v2_revisions (
  property_id UUID NOT NULL REFERENCES pms.pricing_v2_heads(property_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_revisions JSONB NOT NULL CHECK (jsonb_typeof(source_revisions) = 'object'),
  owner_references JSONB NOT NULL CHECK (jsonb_typeof(owner_references) = 'object'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, revision),
  UNIQUE (property_id, request_id),
  UNIQUE (property_id, revision, currency)
);
-- Database defense for exact amount representation, including nested schedules.
CREATE FUNCTION pms.pricing_v2_valid_amounts(value JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k TEXT; v JSONB;
BEGIN
  IF jsonb_typeof(value) = 'object' THEN
    FOR k,v IN SELECT * FROM jsonb_each(value) LOOP
      IF k IN ('amountMinor','unitMinor','baseMinor','nightlyMinor','adultMinor','deltaMinor') THEN
        IF jsonb_typeof(v) <> 'string' OR NOT ((v #>> '{}') ~
          CASE WHEN k='deltaMinor' THEN '^(0|-?[1-9][0-9]{0,17})$' ELSE '^(0|[1-9][0-9]{0,17})$' END) THEN RETURN FALSE; END IF;
      ELSIF k IN ('amountsMinor','childBandAmountsMinor') THEN
        IF jsonb_typeof(v) <> 'array' THEN RETURN FALSE; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) a WHERE jsonb_typeof(a) <> 'string'
          OR NOT ((a #>> '{}') ~ '^(0|[1-9][0-9]{0,17})$')) THEN RETURN FALSE; END IF;
      END IF;
      IF NOT pms.pricing_v2_valid_amounts(v) THEN RETURN FALSE; END IF;
    END LOOP;
  ELSIF jsonb_typeof(value) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(value) LOOP
      IF NOT pms.pricing_v2_valid_amounts(v) THEN RETURN FALSE; END IF;
    END LOOP;
  END IF;
  RETURN TRUE;
END;
$$;
CREATE TABLE pms.pricing_v2_rooms (
  property_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  room_type_id UUID NOT NULL,
  currency TEXT NOT NULL,
  configuration JSONB NOT NULL,
  PRIMARY KEY (property_id, revision, room_type_id),
  FOREIGN KEY (property_id, revision, currency) REFERENCES pms.pricing_v2_revisions(property_id, revision, currency),
  FOREIGN KEY (room_type_id, property_id) REFERENCES pms.room_types(id, property_id),
  CHECK ((configuration->>'version' = 'pricing.v2'
    AND configuration->>'propertyId' = property_id::text
    AND configuration->>'roomTypeId' = room_type_id::text
    AND configuration->>'currency' = currency
    AND configuration->>'revision' = revision::text
    AND (configuration #>> '{capacity,adults}')::integer > 0
    AND (configuration #>> '{capacity,total}')::integer >= (configuration #>> '{capacity,adults}')::integer
    AND (configuration #>> '{capacity,children}')::integer >= 0
    AND jsonb_typeof(configuration->'offers') = 'array'
    AND jsonb_array_length(configuration->'offers') > 0) IS TRUE),
  CHECK (pms.pricing_v2_valid_amounts(configuration))
);
CREATE TABLE pms.pricing_v2_drafts (
  property_id UUID NOT NULL REFERENCES pms.pricing_v2_heads(property_id),
  draft_id UUID NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision > 0),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  source_revisions JSONB NOT NULL CHECK (jsonb_typeof(source_revisions) = 'object'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pms.pricing_v2_valid_amounts(snapshot)),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  PRIMARY KEY (property_id, draft_id)
);
CREATE FUNCTION pms.pricing_v2_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Accepted pricing revisions are immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER pricing_v2_revisions_immutable BEFORE UPDATE OR DELETE ON pms.pricing_v2_revisions
  FOR EACH ROW EXECUTE FUNCTION pms.pricing_v2_immutable();
CREATE TRIGGER pricing_v2_rooms_immutable BEFORE UPDATE OR DELETE ON pms.pricing_v2_rooms
  FOR EACH ROW EXECUTE FUNCTION pms.pricing_v2_immutable();
