import type { Pool } from "pg";
import { readChannexAriResponse } from "../integrations/channexAriReceipt.js";

/** Internal original-dispatch correlation, never public caller authorization. */
type Correlation = {
  receiptId: string;
  attemptId: string;
  jobAttemptId: string;
  workerId: string;
  propertyId: string;
  connectionId: string;
};

/** Consume once, then retry only persistence with the same immutable observation.
 * The pool must bound connection acquisition. No current pricing authority is granted.
 */
export function prepareChannexAriReceiptPersistence(
  pool: Pick<Pool, "connect">,
  correlation: Correlation,
  response: Response,
) {
  return prepareReceiptPersistence(pool, correlation, response);
}

/** Fixed ambiguous-transport evidence only; never persist exception text. */
export function prepareChannexAriTransportFailurePersistence(
  pool: Pick<Pool, "connect">,
  correlation: Correlation,
) {
  return prepareReceiptPersistence(pool, correlation, null);
}

async function prepareReceiptPersistence(
  pool: Pick<Pool, "connect">,
  correlation: Correlation,
  response: Response | null,
) {
  const scope = { ...correlation };
  for (const key of [
    "receiptId",
    "attemptId",
    "jobAttemptId",
    "propertyId",
    "connectionId",
  ] as const)
    if (
      typeof scope[key] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scope[key])
    )
      throw new Error("Invalid Channex receipt correlation");
  if (
    typeof scope.workerId !== "string" ||
    !scope.workerId ||
    scope.workerId !== scope.workerId.trim()
  )
    throw new Error("Invalid Channex receipt worker");
  const observation =
    response === null
      ? {
          outcome: "transport_error" as const,
          httpStatus: null,
          providerRequestId: null,
          taskIds: [],
          hasWarnings: true,
          warningReason: null,
        }
      : await readChannexAriResponse(response);
  const values = [
    scope.receiptId,
    scope.attemptId,
    scope.jobAttemptId,
    scope.workerId,
    observation.outcome,
    observation.httpStatus,
    observation.providerRequestId,
    observation.taskIds,
    observation.hasWarnings,
    observation.warningReason,
  ];
  return async function persist() {
    const client = await pool.connect();
    let committed = false;
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='150ms'");
      const target = await client.query(
        `SELECT t.id FROM pms.channex_offer_targets t
         JOIN pms.channex_offer_ari_attempts a ON a.target_id=t.id
         WHERE a.id=$1 AND a.job_attempt_id=$2 AND a.worker_id=$3
           AND a.state='unresolved'
           AND t.property_id=$4 AND t.connection_id=$5
         FOR UPDATE OF t NOWAIT`,
        [scope.attemptId, scope.jobAttemptId, scope.workerId, scope.propertyId, scope.connectionId],
      );
      if (!target.rows.length) throw new Error("Channex receipt correlation unavailable");
      await client.query(
        `INSERT INTO pms.channex_offer_ari_receipts
         (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,provider_request_id,task_ids,has_warnings,warning_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10) ON CONFLICT(id) DO NOTHING`,
        values,
      );
      const receipt = await client.query(
        `SELECT id FROM pms.channex_offer_ari_receipts
         WHERE id=$1 AND attempt_id=$2 AND job_attempt_id=$3 AND worker_id=$4
           AND outcome=$5 AND http_status IS NOT DISTINCT FROM $6::integer
           AND provider_request_id IS NOT DISTINCT FROM $7::text
           AND task_ids=$8::uuid[] AND has_warnings=$9
           AND warning_reason IS NOT DISTINCT FROM $10::text`,
        values,
      );
      if (!receipt.rows.length) throw new Error("Channex receipt conflict");
      await client.query("COMMIT");
      committed = true;
      return { kind: "retained" as const, receiptId: scope.receiptId };
    } finally {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
      }
      client.release(discard);
    }
  };
}
