-- A closure successor records owner refresh work while channel workers are paused.
-- Ordinary calendar and rule changes continue to enqueue restriction delivery.
CREATE OR REPLACE FUNCTION pms.restriction_ari_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='operating_calendar_revisions' AND TG_OP='INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM pms.room_type_closures closure
      JOIN platform.domain_events event ON event.id=NEW.domain_event_id
        AND event.property_id=closure.property_id AND event.source_system='pms'
        AND event.event_type='pms.room_type.closed'
        AND event.resource_product='pms' AND event.resource_type='room_type'
        AND event.resource_id=closure.room_type_id::text
        AND event.payload->>'commandId'=closure.command_id::text
      WHERE closure.property_id=NEW.property_id
        AND closure.closed_calendar_revision=NEW.calendar_revision
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM pms.enqueue_restriction_ari(OLD.property_id,'rules:'||txid_current());
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pms.enqueue_restriction_ari(NEW.property_id,'rules:'||txid_current());
  END IF;
  RETURN NULL;
END;
$$;
