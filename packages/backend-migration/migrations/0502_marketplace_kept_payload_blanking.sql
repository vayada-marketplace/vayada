-- Migration: 0502_marketplace_kept_payload_blanking
-- Owner: platform / VAY-2272 (Marketplace removal step 5, decision 10, window W3 right after 0500). HOLD:
-- merge only with Flamur's yes, after the counts-0502 before-run.
--
-- Blanks what kept history and queue rows still say about the Marketplace and the removed creators;
-- every row stays, only its contents go (decision 10):
-- - domain events and product audit events of the Marketplace or of a creator or affiliate
--   organization, and those of a removed user (0500's blank rows, removed-*@removed.invalid) outside
--   any hotel or property: a hotel's own history stays as it is, because hotel features read it
-- - outbox events, jobs and dead letters of the Marketplace or of those organizations
-- Finance rows keep their contents (finance resources, financial audit rows), so the payouts 0500
-- keeps stay explained. Free-text summaries (dead-letter summaries, failure reasons, attempt errors)
-- stay too.
-- As its own yes (decision 10), it also blanks once the raw copies of processed WorkOS webhook
-- receipts, which hold every user's e-mail: those a normalized or ignored marker names, or a
-- dead-lettered one whose dead letter is resolved. It is a one-time clean-up, not a retention rule:
-- payload_purged_at stays NULL, because its check allows it only for Stripe and Channex messages.
-- The append-only triggers are switched off only inside this transaction (0153 and 0487 pattern) and
-- come back unchanged, so the Channex worker's trigger catalog digest stays the same.
-- Rollback: any image from the 0500 release on; nothing reads these contents back.

SET LOCAL lock_timeout = '5s';
-- A run too slow for next-api's start fails cleanly on the first slow statement.
SET LOCAL statement_timeout = '30s';

-- Switching a trigger needs this lock: writes to these three tables wait until the end, reads go on.
-- Jobs, outbox events and dead letters are updated under row locks only.
LOCK TABLE platform.domain_events, platform.external_webhook_events, platform.product_audit_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE blanked_organizations ON COMMIT DROP AS
  SELECT id FROM identity.organizations WHERE kind IN ('creator_workspace', 'affiliate_partner');
CREATE TEMP TABLE blanked_users ON COMMIT DROP AS
  SELECT id FROM identity.users WHERE email LIKE 'removed-%@removed.invalid';

-- 0500 canceled the Marketplace's queued work; a job or outbox event still open would lose its input.
-- Finance rows keep their contents below, so open finance work does not stop this.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.jobs
    WHERE status IN ('pending', 'running') AND resource_product <> 'finance'
      AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
  ) OR EXISTS (
    SELECT 1 FROM platform.outbox_events
    WHERE status IN ('pending', 'leased') AND resource_product <> 'finance'
      AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
  ) THEN
    RAISE EXCEPTION 'Marketplace or creator jobs or outbox events are still open';
  END IF;
END $$;

ALTER TABLE platform.domain_events DISABLE TRIGGER trg_platform_domain_events_append_only;
ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only;
ALTER TABLE platform.external_webhook_events DISABLE TRIGGER trg_platform_external_webhook_events_append_only;

-- Each statement picks its rows from narrow columns first, so stored contents are read only for the
-- rows it blanks.
WITH target AS MATERIALIZED (
  SELECT id FROM platform.domain_events
  WHERE resource_product <> 'finance'
    AND (source_system = 'marketplace' OR resource_product = 'marketplace'
         OR organization_id IN (SELECT id FROM blanked_organizations)
         OR (actor_user_id IN (SELECT id FROM blanked_users) AND organization_id IS NULL AND property_id IS NULL))
)
UPDATE platform.domain_events
  SET payload = '{}'::jsonb, event_metadata = '{}'::jsonb
  WHERE id IN (SELECT id FROM target) AND (payload <> '{}'::jsonb OR event_metadata <> '{}'::jsonb);

WITH target AS MATERIALIZED (
  SELECT id FROM platform.product_audit_events
  WHERE product <> 'finance' AND retention_class <> 'financial'
    AND (product = 'marketplace'
         OR organization_id IN (SELECT id FROM blanked_organizations)
         OR (actor_user_id IN (SELECT id FROM blanked_users) AND organization_id IS NULL AND property_id IS NULL))
)
UPDATE platform.product_audit_events
  SET redacted_payload = '{}'::jsonb, private_payload = '{}'::jsonb, audit_metadata = '{}'::jsonb
  WHERE id IN (SELECT id FROM target)
    AND (redacted_payload <> '{}'::jsonb OR private_payload <> '{}'::jsonb OR audit_metadata <> '{}'::jsonb);

WITH target AS MATERIALIZED (
  SELECT id FROM platform.outbox_events
  WHERE resource_product <> 'finance'
    AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
)
UPDATE platform.outbox_events
  SET payload = '{}'::jsonb, outbox_metadata = '{}'::jsonb
  WHERE id IN (SELECT id FROM target) AND (payload <> '{}'::jsonb OR outbox_metadata <> '{}'::jsonb);

WITH target AS MATERIALIZED (
  SELECT id FROM platform.jobs
  WHERE resource_product <> 'finance'
    AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
)
UPDATE platform.jobs
  SET payload = '{}'::jsonb, job_metadata = '{}'::jsonb
  WHERE id IN (SELECT id FROM target) AND (payload <> '{}'::jsonb OR job_metadata <> '{}'::jsonb);

WITH target AS MATERIALIZED (
  SELECT id FROM platform.dead_letter_events
  WHERE resource_product <> 'finance'
    AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
)
UPDATE platform.dead_letter_events
  SET failure_payload = '{}'::jsonb
  WHERE id IN (SELECT id FROM target) AND failure_payload <> '{}'::jsonb;

-- A receipt no marker names, or whose dead letter is still open, keeps its copy.
WITH target AS MATERIALIZED (
  SELECT receipt.id FROM platform.external_webhook_events receipt
  WHERE receipt.provider = 'workos'
    AND EXISTS (
      SELECT 1 FROM identity.auth_reconciliation_events marker
      WHERE marker.provider = 'workos' AND marker.provider_event_id = receipt.id::text
        AND marker.event_type IN ('workos.webhook.normalized', 'workos.webhook.ignored', 'workos.webhook.dead_lettered')
    )
    AND NOT EXISTS (
      SELECT 1 FROM platform.dead_letter_events dead
      WHERE dead.webhook_event_id = receipt.id AND dead.recovery_status <> 'resolved'
    )
)
UPDATE platform.external_webhook_events
  SET raw_payload = '{}'::jsonb, raw_headers = '{}'::jsonb
  WHERE id IN (SELECT id FROM target) AND (raw_payload <> '{}'::jsonb OR raw_headers <> '{}'::jsonb);

ALTER TABLE platform.external_webhook_events ENABLE TRIGGER trg_platform_external_webhook_events_append_only;
ALTER TABLE platform.product_audit_events ENABLE TRIGGER trg_platform_product_audit_events_append_only;
ALTER TABLE platform.domain_events ENABLE TRIGGER trg_platform_domain_events_append_only;

DO $$
BEGIN
  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger
    WHERE tgname IN ('trg_platform_domain_events_append_only', 'trg_platform_product_audit_events_append_only',
                     'trg_platform_external_webhook_events_append_only')
      AND tgenabled = 'O'
  ) <> 3 THEN
    RAISE EXCEPTION 'An append-only trigger is not enabled';
  END IF;
END $$;
