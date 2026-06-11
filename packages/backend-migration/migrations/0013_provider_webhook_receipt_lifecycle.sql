-- Migration: 0013_provider_webhook_receipt_lifecycle
-- Owner: platform-events-audit
-- See: engineering/channex-webhook-cutover-plan.md
--
-- Lets target provider webhook intake use the cutover plan receipt lifecycle:
-- observed -> promoted/succeeded/failed/dead_lettered/ignored. Raw receipt
-- fields remain immutable; only lifecycle columns may change.

ALTER TABLE platform.external_webhook_events
  DROP CONSTRAINT IF EXISTS chk_platform_external_webhook_events_processing;

ALTER TABLE platform.external_webhook_events
  DROP CONSTRAINT IF EXISTS external_webhook_events_delivery_status_check;

ALTER TABLE platform.external_webhook_events
  ADD CONSTRAINT external_webhook_events_delivery_status_check
  CHECK (delivery_status IN (
    'received',
    'validated',
    'observed',
    'promoted',
    'normalized',
    'succeeded',
    'ignored',
    'failed',
    'dead_lettered'
  ));

ALTER TABLE platform.external_webhook_events
  ADD CONSTRAINT chk_platform_external_webhook_events_processing
  CHECK (
    delivery_status NOT IN ('promoted', 'normalized', 'succeeded')
    OR normalized_domain_event_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION platform.prevent_external_webhook_receipt_raw_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform append-only table % cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.provider_event_id IS DISTINCT FROM NEW.provider_event_id
    OR OLD.webhook_key_hash IS DISTINCT FROM NEW.webhook_key_hash
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.signature_verified IS DISTINCT FROM NEW.signature_verified
    OR OLD.received_at IS DISTINCT FROM NEW.received_at
    OR OLD.tenant_scope IS DISTINCT FROM NEW.tenant_scope
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.property_id IS DISTINCT FROM NEW.property_id
    OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
    OR OLD.raw_headers IS DISTINCT FROM NEW.raw_headers
    OR OLD.raw_payload IS DISTINCT FROM NEW.raw_payload
    OR OLD.privacy_scope IS DISTINCT FROM NEW.privacy_scope
    OR OLD.ai_visible IS DISTINCT FROM NEW.ai_visible
  THEN
    RAISE EXCEPTION 'platform webhook receipt raw fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  -- Per channex-webhook-cutover-plan, failed remains retryable; dead_lettered is terminal.
  IF OLD.delivery_status IN ('promoted', 'normalized', 'succeeded', 'ignored', 'dead_lettered')
    AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status
  THEN
    RAISE EXCEPTION 'platform webhook receipt terminal status cannot change'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_external_webhook_events_append_only
  ON platform.external_webhook_events;

CREATE TRIGGER trg_platform_external_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON platform.external_webhook_events
  FOR EACH ROW
  EXECUTE FUNCTION platform.prevent_external_webhook_receipt_raw_mutation();
