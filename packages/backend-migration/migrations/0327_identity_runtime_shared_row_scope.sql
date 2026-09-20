-- VAY-2038: preserve existing roles while scoping the future non-owner identity
-- credential on shared platform tables. Grants and credential routing are
-- separate, reviewed rollout steps.

ALTER TABLE platform.external_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.external_webhook_events
  TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR provider = 'workos');

ALTER TABLE platform.idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.idempotency_keys
  TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR operation_scope = 'identity');

ALTER TABLE platform.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.jobs
  TO PUBLIC
  USING (
    current_user <> 'vayada_next_identity_runtime'
    OR (queue_name = 'identity.webhooks' AND job_type = 'identity.workos_webhook.reconcile'
        AND resource_product = 'identity')
    OR (queue_name = 'identity-provider' AND job_type = 'workos.organization-membership.delete'
        AND resource_product = 'identity')
    OR (queue_name = 'identity-admin-transfer' AND job_type = 'identity.membership_role.reconcile'
        AND resource_product = 'identity')
    OR (queue_name = 'pms-inbox' AND job_type = 'pms.inbox.assignment.reconcile'
        AND resource_product = 'pms' AND resource_type = 'inbox_assignment')
  );

ALTER TABLE platform.product_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.product_audit_events
  TO PUBLIC
  USING (current_user <> 'vayada_next_identity_runtime' OR product = 'identity');

ALTER TABLE platform.dead_letter_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_runtime_scope ON platform.dead_letter_events
  TO PUBLIC
  USING (
    current_user <> 'vayada_next_identity_runtime'
    OR (source_kind = 'webhook' AND resource_product = 'identity'
        AND resource_type = 'workos_webhook'
        AND EXISTS (
          SELECT 1 FROM platform.external_webhook_events AS receipt
           WHERE receipt.id = webhook_event_id AND receipt.provider = 'workos'
        ))
  );
