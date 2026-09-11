import type { PoolClient } from "pg";
import { PMS_CHANNEX_MANAGEMENT_QUEUE } from "../domains/pmsChannexManagementReadModel.js";

export const CHANNEX_JOB_LEASE_MS = 5 * 60_000;
export type ChannexPricingJobLeaseInput = Readonly<{
  jobId: string;
  workerId: string;
  attemptNumber: number;
}>;
export type ChannexPricingJobLease = ChannexPricingJobLeaseInput &
  Readonly<{
    propertyId: string;
    operationType: "provision" | "sync_ari" | "update_markups";
  }>;

/** Caller must own a transaction and roll back on lock contention (55P03).
 * NOWAIT avoids a blocking reverse order with the job-first worker claim path.
 * This proves only the current lease, not property authority or price freshness.
 * Recheck at the final read boundary; this function never renews the lease.
 */
export async function lockChannexPricingJobLease(
  client: PoolClient,
  input: ChannexPricingJobLeaseInput,
): Promise<ChannexPricingJobLease | null> {
  if (
    !input ||
    typeof input.jobId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.jobId) ||
    typeof input.workerId !== "string" ||
    !input.workerId.trim() ||
    !Number.isSafeInteger(input.attemptNumber) ||
    input.attemptNumber < 1 ||
    input.attemptNumber > 2147483647
  )
    return null;
  const result = await client.query<ChannexPricingJobLease>(
    `SELECT j.id::text AS "jobId", j.property_id::text AS "propertyId",
       j.locked_by AS "workerId", j.attempts_count AS "attemptNumber",
       j.payload->>'operationType' AS "operationType"
     FROM platform.jobs j JOIN platform.job_attempts a
       ON a.job_id=j.id AND a.attempt_number=j.attempts_count
     WHERE j.id=$1::uuid AND j.locked_by=$2 AND j.attempts_count=$3
       AND j.status='running' AND a.status='running' AND a.worker_id=$2
       AND j.finished_at IS NULL AND a.finished_at IS NULL
       AND j.locked_at > clock_timestamp() - ($4::bigint * interval '1 millisecond')
       AND j.locked_at <= clock_timestamp()
       AND j.queue_name=$5 AND j.tenant_scope='property' AND j.property_id IS NOT NULL
       AND j.resource_product='pms' AND j.resource_type='channex_connection'
       AND j.resource_id=j.property_id::text
       AND j.payload->>'operationType' IN ('provision','sync_ari','update_markups')
       AND j.job_type='channex.' || (j.payload->>'operationType')
     FOR SHARE OF j,a NOWAIT`,
    [
      input.jobId,
      input.workerId,
      input.attemptNumber,
      CHANNEX_JOB_LEASE_MS,
      PMS_CHANNEX_MANAGEMENT_QUEUE,
    ],
  );
  return result.rows[0] ?? null;
}
