-- PMS-owned, immutable evidence for one explicitly approved staging repair.
-- Contract: engineering/channex-staging-room-adoption.md. No pricing ownership.
CREATE TABLE pms.channex_staging_catalog_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  binding_generation UUID NOT NULL,
  provider_property_id UUID NOT NULL,
  guest_booking_id UUID NOT NULL,
  provider_booking_id UUID NOT NULL,
  provider_revision_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  external_room_type_id UUID NOT NULL,
  external_rate_plan_id UUID NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  audit_event_id UUID NOT NULL REFERENCES platform.product_audit_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, provider_booking_id, provider_revision_id),
  FOREIGN KEY (connection_id, property_id) REFERENCES pms.channel_connections(id, property_id),
  CONSTRAINT fk_pms_staging_catalog_room_property FOREIGN KEY (room_type_id, property_id) REFERENCES pms.room_types(id, property_id),
  FOREIGN KEY (guest_booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id)
);

CREATE FUNCTION pms.reject_staging_catalog_reference_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Staging catalog references are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER staging_catalog_reference_immutable
BEFORE UPDATE OR DELETE ON pms.channex_staging_catalog_references
FOR EACH ROW EXECUTE FUNCTION pms.reject_staging_catalog_reference_rewrite();
