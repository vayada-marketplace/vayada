import type { PoolClient } from "pg";

/** Must run under the owning target lock; receipts fence that same target. */
export function readChannexInitialAriHistory(
  client: PoolClient,
  identity: { externalPropertyId: string; externalRatePlanId: string },
  creationAttemptId: string,
  excludedAttemptId: string | null = null,
) {
  return client.query<{ date: string; verified: boolean | null }>(
    `SELECT a.service_date::text AS date,
                  (a.creation_attempt_id=$3 AND a.state='reconciled'
                    AND a.reconciliation_evidence->>'schemaVersion'='1'
                    AND a.reconciliation_evidence->>'completionBasis'='finished_task_fifo'
                    AND a.reconciliation_evidence->>'observationsSha256' ~ '^[a-f0-9]{64}$'
                    AND (SELECT count(*) FROM pms.channex_offer_ari_receipts r WHERE r.attempt_id=a.id)=1
                    AND EXISTS (SELECT 1 FROM pms.channex_offer_ari_receipts r
                      WHERE r.attempt_id=a.id AND r.id::text=a.reconciliation_evidence->>'originalReceiptId'
                        AND r.outcome='complete_json' AND r.http_status=200 AND NOT r.has_warnings
                        AND cardinality(r.task_ids)>0
                        AND a.reconciliation_evidence->'taskCount'=to_jsonb(cardinality(r.task_ids)))) AS verified
                 FROM pms.channex_offer_ari_attempts a
                 WHERE a.external_property_id=$1 AND a.external_rate_plan_id=$2
                   AND a.state IN ('unresolved','reconciled')
                   AND ($4::uuid IS NULL OR a.id<>$4::uuid)
                 ORDER BY a.service_date`,
    [
      identity.externalPropertyId,
      identity.externalRatePlanId,
      creationAttemptId,
      excludedAttemptId,
    ],
  );
}
