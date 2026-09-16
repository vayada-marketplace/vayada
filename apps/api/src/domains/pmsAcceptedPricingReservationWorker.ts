import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import {
  createPgPmsAcceptedPricingReservationPort,
  PmsAcceptedPricingReservationConflict,
} from "./pmsAcceptedPricingReservationRepository.js";
import {
  PMS_ACCEPTED_PRICING_JOB_TYPE,
  PMS_ACCEPTED_PRICING_JOB_VERSION,
  PMS_ACCEPTED_PRICING_QUEUE,
} from "./pricingPmsAcceptedReservationJob.js";
import {
  loadAcceptedPricingReservation,
  type AcceptedPricingReservationReference,
} from "./pricingPmsAcceptedReservation.js";

type Claim = {
  jobId: string;
  attemptId: string;
  attemptsCount: number;
  maxAttempts: number;
  propertyId: string;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  correlationId: string | null;
  jobKey: string;
  payload: unknown;
};
type FailureReason = "invalid_payload" | "immutable_conflict" | "max_attempts_exhausted";

export function createPmsAcceptedPricingReservationWorker(config: {
  connectionString: string;
  pool?: pg.Pool;
  randomId?: () => string;
}) {
  const ownsPool = !config.pool;
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 2 });
  const makeId = config.randomId ?? randomUUID;
  return {
    async processNext(): Promise<"adopted" | "replayed" | "deferred" | "dead_lettered" | "empty"> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const workerId = `pms-accepted-pricing:${process.pid}:${makeId()}`;
        const outcome = await processNextPmsAcceptedPricingReservationJob(client, workerId);
        if (outcome === "empty") {
          await client.query("ROLLBACK");
          return "empty";
        }
        await client.query("COMMIT");
        return outcome;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

/** Process one locked job inside the caller's transaction. PostgreSQL's row
 * lock is the duplicate-worker lease; the wrapper above owns BEGIN/COMMIT. */
export async function processNextPmsAcceptedPricingReservationJob(
  client: PoolClient,
  workerId: string,
): Promise<"adopted" | "replayed" | "deferred" | "dead_lettered" | "empty"> {
  const claim = await claimNext(client, workerId);
  if (!claim) return "empty";
  const reference = parseReference(claim.payload);
  if (!reference || !validEnvelope(claim, reference)) {
    await finishFailure(client, claim, "invalid_payload", "invalid_job_payload", true);
    return "dead_lettered";
  }
  try {
    const command = await loadAcceptedPricingReservation(client, reference);
    if (!command) throw new PmsAcceptedPricingReservationConflict();
    const result =
      await createPgPmsAcceptedPricingReservationPort(client).adoptAcceptedPricingReservation(
        command,
      );
    await finishSuccess(client, claim, result.outcome);
    return result.outcome;
  } catch (error) {
    const terminal = error instanceof PmsAcceptedPricingReservationConflict;
    const exhausted = claim.attemptsCount >= claim.maxAttempts;
    const reason = terminal
      ? "immutable_conflict"
      : exhausted
        ? "max_attempts_exhausted"
        : "immutable_conflict";
    await finishFailure(
      client,
      claim,
      reason,
      terminal ? error.message : safeMessage(error),
      terminal || exhausted,
    );
    return terminal || exhausted ? "dead_lettered" : "deferred";
  }
}

async function claimNext(client: PoolClient, workerId: string): Promise<Claim | null> {
  const row = (
    await client.query<Claim>(
      `WITH candidate AS (
         SELECT id FROM platform.jobs
         WHERE queue_name=$1 AND job_type=$2 AND status='pending'
           AND attempts_count<max_attempts AND run_after<=clock_timestamp()
         ORDER BY priority DESC,run_after,id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE platform.jobs job SET status='running',attempts_count=job.attempts_count+1,
         locked_at=clock_timestamp(),locked_by=$3,updated_at=clock_timestamp()
       FROM candidate WHERE job.id=candidate.id
       RETURNING job.id::text AS "jobId",job.attempts_count AS "attemptsCount",
         job.max_attempts AS "maxAttempts",job.property_id::text AS "propertyId",
         job.resource_product AS "resourceProduct",job.resource_type AS "resourceType",
         job.resource_id AS "resourceId",job.correlation_id AS "correlationId",
         job.job_key AS "jobKey",job.payload`,
      [PMS_ACCEPTED_PRICING_QUEUE, PMS_ACCEPTED_PRICING_JOB_TYPE, workerId],
    )
  ).rows[0];
  if (!row) return null;
  const attempt = await client.query<{ attemptId: string }>(
    `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id)
     VALUES($1::uuid,$2,'running',$3) RETURNING id::text AS "attemptId"`,
    [row.jobId, row.attemptsCount, workerId],
  );
  return { ...row, attemptId: attempt.rows[0]!.attemptId };
}

async function finishSuccess(client: PoolClient, claim: Claim, outcome: "adopted" | "replayed") {
  const attempt = await client.query(
    `UPDATE platform.job_attempts SET status='succeeded',finished_at=clock_timestamp()
     WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'`,
    [claim.jobId, claim.attemptsCount],
  );
  const job = await client.query(
    `UPDATE platform.jobs SET status='succeeded',finished_at=clock_timestamp(),
       locked_at=NULL,locked_by=NULL,updated_at=clock_timestamp(),
       job_metadata=job_metadata || jsonb_build_object('outcome',$3::text)
     WHERE id=$1::uuid AND status='running' AND attempts_count=$2`,
    [claim.jobId, claim.attemptsCount, outcome],
  );
  if (attempt.rowCount !== 1 || job.rowCount !== 1)
    throw new Error("PMS accepted-pricing job completion conflict");
}

async function finishFailure(
  client: PoolClient,
  claim: Claim,
  reason: FailureReason,
  message: string,
  terminal: boolean,
) {
  const attempt = await client.query(
    `UPDATE platform.job_attempts SET status='failed',finished_at=clock_timestamp(),
       error_type=$3,error_message=$4,
       retry_after=CASE WHEN $5::boolean THEN NULL ELSE clock_timestamp()+interval '1 minute' END
     WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'`,
    [claim.jobId, claim.attemptsCount, terminal ? reason : "transient", message, terminal],
  );
  const job = await client.query(
    `UPDATE platform.jobs SET status=$3,finished_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
       run_after=CASE WHEN $4 THEN run_after ELSE clock_timestamp()+interval '1 minute' END,
       locked_at=NULL,locked_by=NULL,updated_at=clock_timestamp(),
       job_metadata=job_metadata || jsonb_build_object('lastError',$5::text)
     WHERE id=$1::uuid AND status='running' AND attempts_count=$2`,
    [claim.jobId, claim.attemptsCount, terminal ? "dead_lettered" : "pending", terminal, message],
  );
  if (attempt.rowCount !== 1 || job.rowCount !== 1)
    throw new Error("PMS accepted-pricing job failure conflict");
  if (!terminal) return;
  await client.query(
    `INSERT INTO platform.dead_letter_events
     (source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,
      resource_type,resource_id,correlation_id,reason_code,failure_summary,failure_payload)
     SELECT 'job',$1::uuid,$2::uuid,'property',$3::uuid,$4,$5,$6,$7,$8,$9,$10::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM platform.dead_letter_events
       WHERE source_kind='job' AND job_id=$1::uuid AND recovery_status='open')`,
    [
      claim.jobId,
      claim.attemptId,
      claim.propertyId,
      claim.resourceProduct,
      claim.resourceType,
      claim.resourceId,
      claim.correlationId,
      reason,
      message,
      JSON.stringify({ attemptCount: claim.attemptsCount, replayEligible: false }),
    ],
  );
  await client.query(
    `INSERT INTO platform.product_audit_events
     (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
      target_resource_product,target_resource_type,target_resource_id,job_id,
      correlation_id,redacted_payload,audit_metadata)
     VALUES($1,'pms','accepted_pricing_adoption_dead_lettered',clock_timestamp(),
       'property',$2::uuid,'system',$3,$4,$5,$6::uuid,$7,$8::jsonb,$9::jsonb)
     ON CONFLICT(product,audit_key) DO NOTHING`,
    [
      `pms.accepted-pricing.job.${claim.jobId}.dead-letter.v1`,
      claim.propertyId,
      claim.resourceProduct,
      claim.resourceType,
      claim.resourceId,
      claim.jobId,
      claim.correlationId,
      JSON.stringify({ reason }),
      JSON.stringify({ attemptCount: claim.attemptsCount }),
    ],
  );
}

function parseReference(payload: unknown): AcceptedPricingReservationReference | null {
  if (
    !record(payload) ||
    Object.keys(payload).length !== 4 ||
    payload.version !== PMS_ACCEPTED_PRICING_JOB_VERSION ||
    !uuid(payload.propertyId) ||
    !uuid(payload.guestBookingId) ||
    !uuid(payload.acceptanceId)
  )
    return null;
  return payload as AcceptedPricingReservationReference & { version: string };
}

function validEnvelope(claim: Claim, reference: AcceptedPricingReservationReference) {
  return (
    claim.propertyId === reference.propertyId &&
    claim.resourceProduct === "booking" &&
    claim.resourceType === "guest_booking" &&
    claim.resourceId === reference.guestBookingId &&
    claim.correlationId === reference.acceptanceId &&
    claim.jobKey === `pms:pricing-acceptance:${reference.acceptanceId}:create:v1`
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const safeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : "PMS accepted-pricing adoption failed").slice(0, 500);
