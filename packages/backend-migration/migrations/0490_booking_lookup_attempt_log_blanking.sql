-- VAY-2222 (after the API counts "Find my booking" tries in memory): each try's row in the
-- append-only audit log held an unsalted SHA-256 of the caller's address, which only the old
-- limit read. The rows keep only "a lookup try happened at this time": the address hash becomes
-- the row id, and the request and correlation ids go (a caller can set the correlation id).
-- Nothing reads these rows any more, and no writer adds them.
-- The append-only trigger is switched off only inside this transaction (0153/0487 pattern) and
-- comes back unchanged, so the Channex worker's trigger catalog digest stays the same.
SET LOCAL lock_timeout = '5s';

LOCK TABLE platform.product_audit_events IN SHARE ROW EXCLUSIVE MODE;

-- Only after the API stopped writing these rows: a try logged with an address hash in the last
-- hour means it still does (a safety net; the release order is the control).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.product_audit_events
    WHERE product = 'booking' AND action = 'booking.guest_lookup.attempt'
      AND target_resource_type = 'lookup_client_address_hash'
      AND occurred_at > now() - INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'Find my booking tries are still logged with an address hash; release the API that counts them in memory first';
  END IF;
END;
$$;

ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only;

UPDATE platform.product_audit_events
SET target_resource_type = 'lookup_attempt',
    target_resource_id = id::text,
    correlation_id = NULL,
    causation_id = NULL
WHERE product = 'booking'
  AND action = 'booking.guest_lookup.attempt'
  AND target_resource_product = 'booking'
  AND target_resource_type = 'lookup_client_address_hash';

ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only;
