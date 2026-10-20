-- Migration: 0502_marketplace_kept_payload_blanking
-- Owner: platform / VAY-2272 (Marketplace removal step 5, decision 10, window W3 right after 0500). HOLD:
-- merge only with Flamur's yes, after the counts-0502 before-run.
--
-- Blanks what kept history and queue rows still say about the Marketplace and the removed creators;
-- every row stays, only its contents go (decision 10):
-- - domain events and product audit events of the Marketplace, of a removed user (0500 left them as
--   blank rows, removed-*@removed.invalid) or of a creator or affiliate organization
-- - outbox events, jobs and dead letters of the Marketplace or of those organizations
-- As its own yes (decision 10), it also blanks once the raw copies of every processed WorkOS webhook
-- receipt, which hold every user's e-mail. That is a one-time clean-up, not a retention rule:
-- payload_purged_at stays NULL, because its check allows it only for Stripe and Channex messages.
-- Receipts of those organizations from other providers are Stripe ones, which their retention purges.
-- The append-only triggers are switched off only inside this transaction (0153 and 0487 pattern) and
-- come back unchanged, so the Channex worker's trigger catalog digest stays the same.
-- Rollback: any image from the 0500 release on. Nothing reads these payloads back: the WorkOS reconcile
-- job reads its receipt only until it is processed, and staff-invitation recovery reads identity dead
-- letters, which are not touched.

SET LOCAL lock_timeout = '5s';
-- Each blanking statement scans its table once.
SET LOCAL statement_timeout = '120s';

-- Writes to these tables wait until the end; reads go on. Switching a trigger needs this lock anyway.
LOCK TABLE
  platform.dead_letter_events, platform.domain_events, platform.external_webhook_events, platform.jobs,
  platform.outbox_events, platform.product_audit_events
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE blanked_organizations ON COMMIT DROP AS
  SELECT id FROM identity.organizations WHERE kind IN ('creator_workspace', 'affiliate_partner');
CREATE TEMP TABLE blanked_users ON COMMIT DROP AS
  SELECT id FROM identity.users WHERE email LIKE 'removed-%@removed.invalid';

-- 0500 canceled the Marketplace's queued work; a job or outbox event still open would lose its input.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform.jobs
    WHERE status IN ('pending', 'running')
      AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
  ) OR EXISTS (
    SELECT 1 FROM platform.outbox_events
    WHERE status IN ('pending', 'leased')
      AND (resource_product = 'marketplace' OR organization_id IN (SELECT id FROM blanked_organizations))
  ) THEN
    RAISE EXCEPTION 'Marketplace or creator jobs or outbox events are still open';
  END IF;
END $$;

ALTER TABLE platform.domain_events DISABLE TRIGGER trg_platform_domain_events_append_only;
ALTER TABLE platform.product_audit_events DISABLE TRIGGER trg_platform_product_audit_events_append_only;
ALTER TABLE platform.external_webhook_events DISABLE TRIGGER trg_platform_external_webhook_events_append_only;

UPDATE platform.domain_events domain_event
  SET payload = '{}'::jsonb, event_metadata = '{}'::jsonb
  WHERE (domain_event.source_system = 'marketplace' OR domain_event.resource_product = 'marketplace'
         OR domain_event.actor_user_id IN (SELECT id FROM blanked_users)
         OR domain_event.organization_id IN (SELECT id FROM blanked_organizations))
    AND (domain_event.payload <> '{}'::jsonb OR domain_event.event_metadata <> '{}'::jsonb);

UPDATE platform.product_audit_events audit
  SET redacted_payload = '{}'::jsonb, private_payload = '{}'::jsonb, audit_metadata = '{}'::jsonb
  WHERE (audit.product = 'marketplace'
         OR audit.actor_user_id IN (SELECT id FROM blanked_users)
         OR audit.organization_id IN (SELECT id FROM blanked_organizations))
    AND (audit.redacted_payload <> '{}'::jsonb OR audit.private_payload <> '{}'::jsonb
         OR audit.audit_metadata <> '{}'::jsonb);

UPDATE platform.outbox_events outbox
  SET payload = '{}'::jsonb, outbox_metadata = '{}'::jsonb
  WHERE (outbox.resource_product = 'marketplace' OR outbox.organization_id IN (SELECT id FROM blanked_organizations))
    AND (outbox.payload <> '{}'::jsonb OR outbox.outbox_metadata <> '{}'::jsonb);

UPDATE platform.jobs job
  SET payload = '{}'::jsonb, job_metadata = '{}'::jsonb
  WHERE (job.resource_product = 'marketplace' OR job.organization_id IN (SELECT id FROM blanked_organizations))
    AND (job.payload <> '{}'::jsonb OR job.job_metadata <> '{}'::jsonb);

UPDATE platform.dead_letter_events dead
  SET failure_payload = '{}'::jsonb
  WHERE (dead.resource_product = 'marketplace' OR dead.organization_id IN (SELECT id FROM blanked_organizations))
    AND dead.failure_payload <> '{}'::jsonb;

-- Processed: a WorkOS marker (normalized, ignored or dead-lettered) names the receipt. An unprocessed
-- receipt keeps its copy until the reconcile job has read it.
UPDATE platform.external_webhook_events receipt
  SET raw_payload = '{}'::jsonb, raw_headers = '{}'::jsonb
  WHERE receipt.provider = 'workos'
    AND (receipt.raw_payload <> '{}'::jsonb OR receipt.raw_headers <> '{}'::jsonb)
    AND EXISTS (
      SELECT 1 FROM identity.auth_reconciliation_events marker
      WHERE marker.provider = 'workos' AND marker.provider_event_id = receipt.id::text
        AND marker.event_type IN ('workos.webhook.normalized', 'workos.webhook.ignored', 'workos.webhook.dead_lettered')
    );

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
