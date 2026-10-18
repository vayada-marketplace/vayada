-- VAY-2286: contact-form and in-app support messages written before the API kept them only in
-- the deletable job row left the sender's details in the append-only log: the event payload held
-- every field, the audit row a private copy plus the email domain and country. They become what
-- the API writes now: an empty event payload, an empty private part and no redacted fields. The
-- job rows are emptied by the API's retention worker 90 days after arrival.
-- The append-only triggers are switched off only inside this transaction (0153/0490 pattern) and
-- come back unchanged, so the Channex worker's trigger catalog digest stays the same.
SET LOCAL lock_timeout = '5s';

LOCK TABLE platform.domain_events IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE platform.product_audit_events IN SHARE ROW EXCLUSIVE MODE;

-- Only after the API stopped writing them: a message logged with its fields in the last hour
-- means the old API still runs (a safety net; the release order is the control).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.domain_events
    WHERE source_system = 'platform'
      AND event_type = 'platform.contact_submission.received'
      AND payload ?| ARRAY['name', 'email', 'message']
      AND recorded_at > now() - INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'Contact messages are still written to the event log; release the API that keeps them in the job row first';
  END IF;
END;
$$;

ALTER TABLE platform.domain_events DISABLE TRIGGER trg_platform_domain_events_append_only;

UPDATE platform.domain_events
SET payload = '{}'::jsonb,
    event_metadata = event_metadata - 'redacted'
WHERE source_system = 'platform'
  AND event_type = 'platform.contact_submission.received'
  AND (
    payload ?| ARRAY['name', 'email', 'phone', 'company', 'country', 'userType', 'message']
    OR event_metadata ? 'redacted'
  );

ALTER TABLE platform.domain_events ENABLE TRIGGER trg_platform_domain_events_append_only;

ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only;

UPDATE platform.product_audit_events
SET private_payload = '{}'::jsonb,
    redacted_payload = '{}'::jsonb
WHERE product = 'platform'
  AND action = 'platform.contact_submission.received'
  AND (
    private_payload <> '{}'::jsonb
    OR redacted_payload ?| ARRAY['emailDomain', 'country', 'userType', 'messageLength']
  );

ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only;
