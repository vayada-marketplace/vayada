-- VAY-2108: claimed hotels pass the Channex worker's claim and connection policies on their claim
-- first. The two policies asked 0473's connection_scope('property') before 0519's claimed branch.
-- For a claimed hotel that branch is false (no canary allowlist row, no live enable job), but its
-- platform.jobs lookup (property_id::text = resource, under the jobs policy) runs on every call, and
-- every availability attempt, receipt, attestation and offer upload row the worker reads reaches
-- these policies through worker_source. On Tiga Lombok (2026-11-19) that made single statements
-- pass the 5 s limit from about 1,000 reconciled nights and dead-letter its sync four times.
-- Same branches in the other order: OR is commutative, so every login sees the same rows; the
-- enable-job branch still admits hotels without a claim. The pinned helpers (worker_scope,
-- worker_source, connection_scope, claimed_scope) and the insert policies stay byte-identical.
SET LOCAL lock_timeout = '5s';

ALTER POLICY channex_management_worker_scope ON pms.channel_binding_claims
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND ((claim_state = 'active' AND platform.channex_management_worker_claimed_scope('operations', ''))
      OR platform.channex_management_worker_connection_scope('property', property_id::text))));
ALTER POLICY channex_management_worker_scope ON pms.channel_connections
  USING (current_user <> 'vayada_next_channex_management_worker'
    OR (provider = 'channex' AND ((connection_status IN ('connected', 'degraded')
        AND platform.channex_management_worker_claimed_scope('operations', '')
        AND platform.channex_management_worker_claimed_scope('binding', property_id::text || '/' || external_property_id))
      OR platform.channex_management_worker_connection_scope('property', property_id::text))));
