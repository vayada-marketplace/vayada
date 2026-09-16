-- Reuse the active management worker; jobs contain no rule snapshots.
CREATE FUNCTION pms.enqueue_restriction_ari(property UUID, source TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO platform.jobs(job_key,queue_name,job_type,property_id,tenant_scope,
    resource_product,resource_type,resource_id,payload,job_metadata,max_attempts)
  SELECT 'channex.ari:'||property||':'||source,'pms.channex.management','channex.sync_ari',
    property,'property','pms','channex_connection',property::text,
    jsonb_build_object('operationType','sync_ari','commandId',source,'idempotencyKey',source,
      'restrictionsOnly',TRUE),
    jsonb_build_object('source','canonical_restrictions'),5
  WHERE EXISTS (SELECT 1 FROM pms.channel_connections
    WHERE property_id=property AND provider='channex' AND connection_status IN ('connected','degraded'))
  ON CONFLICT (queue_name,job_key) DO NOTHING;
$$;

CREATE FUNCTION pms.restriction_ari_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pms.enqueue_restriction_ari(OLD.property_id,'rules:'||txid_current());
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pms.enqueue_restriction_ari(NEW.property_id,'rules:'||txid_current());
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pms_restriction_ari_changed AFTER INSERT OR UPDATE OR DELETE ON pms.rate_rules
  FOR EACH ROW EXECUTE FUNCTION pms.restriction_ari_changed();
CREATE TRIGGER pms_calendar_restriction_ari_changed AFTER INSERT ON pms.operating_calendar_revisions
  FOR EACH ROW EXECUTE FUNCTION pms.restriction_ari_changed();

CREATE FUNCTION pms.inventory_outbox_ari_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='pms.inventory.ari_changed' AND NEW.property_id IS NOT NULL THEN
    PERFORM pms.enqueue_restriction_ari(NEW.property_id,'inventory:'||txid_current());
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pms_inventory_outbox_ari_changed AFTER INSERT ON platform.outbox_events
  FOR EACH ROW EXECUTE FUNCTION pms.inventory_outbox_ari_changed();
