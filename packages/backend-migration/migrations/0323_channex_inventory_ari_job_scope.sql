-- Inventory changes must run the full ARI worker, including availability.
-- Restriction sources retain their restrictions-only job scope.
CREATE FUNCTION pms.enqueue_inventory_ari(property UUID, source TEXT)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO platform.jobs(job_key,queue_name,job_type,property_id,tenant_scope,
    resource_product,resource_type,resource_id,payload,job_metadata,max_attempts)
  SELECT 'channex.ari:'||property||':'||source,'pms.channex.management','channex.sync_ari',
    property,'property','pms','channex_connection',property::text,
    jsonb_build_object('operationType','sync_ari','commandId',source,'idempotencyKey',source,
      'restrictionsOnly',FALSE),
    jsonb_build_object('source','canonical_inventory'),5
  WHERE EXISTS (SELECT 1 FROM pms.channel_connections
    WHERE property_id=property AND provider='channex' AND connection_status IN ('connected','degraded'))
  ON CONFLICT (queue_name,job_key) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION pms.inventory_outbox_ari_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='pms.inventory.ari_changed' AND NEW.property_id IS NOT NULL THEN
    PERFORM pms.enqueue_inventory_ari(NEW.property_id,'inventory:'||txid_current());
  END IF;
  RETURN NULL;
END;
$$;
