import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import type { PmsAcceptedPricingReservationCommand } from "@vayada/domain-pms";
import {
  createPgPmsAcceptedPricingReservationPort,
  PmsAcceptedPricingReservationConflict,
} from "./pmsAcceptedPricingReservationRepository.js";
import {
  PMS_ACCEPTED_PRICING_JOB_TYPE,
  PMS_ACCEPTED_PRICING_JOB_VERSION,
  PMS_ACCEPTED_PRICING_QUEUE,
} from "./pricingPmsAcceptedReservationJob.js";

type Claim = {
  jobId: string;
  attemptsCount: number;
  maxAttempts: number;
  payload: unknown;
};

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
  const command = parseCommand(claim.payload);
  if (!command) {
    await finishFailure(client, claim, "invalid_job_payload", true);
    return "dead_lettered";
  }
  try {
    const result =
      await createPgPmsAcceptedPricingReservationPort(client).adoptAcceptedPricingReservation(
        command,
      );
    await finishSuccess(client, claim, result.outcome);
    return result.outcome;
  } catch (error) {
    const terminal = error instanceof PmsAcceptedPricingReservationConflict;
    const exhausted = claim.attemptsCount >= claim.maxAttempts;
    await finishFailure(
      client,
      claim,
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
         job.max_attempts AS "maxAttempts",job.payload`,
      [PMS_ACCEPTED_PRICING_QUEUE, PMS_ACCEPTED_PRICING_JOB_TYPE, workerId],
    )
  ).rows[0];
  if (!row) return null;
  await client.query(
    `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id)
     VALUES($1::uuid,$2,'running',$3)`,
    [row.jobId, row.attemptsCount, workerId],
  );
  return row;
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

async function finishFailure(client: PoolClient, claim: Claim, message: string, terminal: boolean) {
  const attempt = await client.query(
    `UPDATE platform.job_attempts SET status='failed',finished_at=clock_timestamp(),
       error_type=$3,error_message=$4,
       retry_after=CASE WHEN $5::boolean THEN NULL ELSE clock_timestamp()+interval '1 minute' END
     WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'`,
    [
      claim.jobId,
      claim.attemptsCount,
      terminal ? "terminal_conflict" : "transient",
      message,
      terminal,
    ],
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
}

function parseCommand(payload: unknown): PmsAcceptedPricingReservationCommand | null {
  if (!record(payload) || payload.contractVersion !== PMS_ACCEPTED_PRICING_JOB_VERSION) return null;
  const command = payload.command;
  if (
    !record(command) ||
    !record(command.stay) ||
    !record(command.inventoryReservation) ||
    !Array.isArray(command.inventoryReservation.receipts) ||
    !Array.isArray(command.rooms) ||
    !command.rooms.every((room) => record(room) && Array.isArray(room.childAgesAtCheckIn))
  )
    return null;
  return command as PmsAcceptedPricingReservationCommand;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const safeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : "PMS accepted-pricing adoption failed").slice(0, 500);
