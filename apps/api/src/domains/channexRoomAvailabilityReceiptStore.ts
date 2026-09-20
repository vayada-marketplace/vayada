import type { Pool } from "pg";
import { readChannexAriResponse } from "../integrations/channexAriReceipt.js";

type Correlation = Readonly<{
  receiptId: string;
  attemptId: string;
  jobAttemptId: string;
  workerId: string;
  propertyId: string;
  connectionId: string;
}>;

/** Captures the original response before any current-authority reconciliation. */
export function prepareChannexRoomAvailabilityReceiptPersistence(
  pool: Pick<Pool, "connect">,
  correlation: Correlation,
  response: Response,
) {
  return preparePersistence(pool, correlation, response);
}

/** A thrown or timed-out POST is an ambiguous mutation; exception text is discarded. */
export function prepareChannexRoomAvailabilityTransportFailurePersistence(
  pool: Pick<Pool, "connect">,
  correlation: Correlation,
) {
  return preparePersistence(pool, correlation, null);
}

async function preparePersistence(
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
    if (!uuid(scope[key])) throw new Error("Invalid Channex availability receipt correlation");
  if (
    typeof scope.workerId !== "string" ||
    !scope.workerId ||
    scope.workerId !== scope.workerId.trim()
  )
    throw new Error("Invalid Channex availability receipt worker");
  const observation = response
    ? await readChannexAriResponse(response)
    : {
        outcome: "transport_error" as const,
        httpStatus: null,
        providerRequestId: null,
        taskIds: [],
        hasWarnings: true,
        warningReason: null,
      };
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
    let committed = false,
      discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL lock_timeout='150ms'");
      const attempt = await client.query(
        `SELECT id FROM pms.channex_room_availability_attempts
         WHERE id=$1 AND job_attempt_id=$2 AND worker_id=$3
           AND property_id=$4 AND connection_id=$5
           AND state='unresolved'
         FOR SHARE NOWAIT`,
        [scope.attemptId, scope.jobAttemptId, scope.workerId, scope.propertyId, scope.connectionId],
      );
      if (!attempt.rowCount)
        throw new Error("Channex availability receipt correlation unavailable");
      await client.query(
        `INSERT INTO pms.channex_room_availability_receipts
         (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,
          provider_request_id,task_ids,has_warnings,warning_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10) ON CONFLICT DO NOTHING`,
        values,
      );
      const exact = await client.query(
        `SELECT id FROM pms.channex_room_availability_receipts
         WHERE id=$1 AND attempt_id=$2 AND job_attempt_id=$3 AND worker_id=$4
           AND outcome=$5 AND http_status IS NOT DISTINCT FROM $6::integer
           AND provider_request_id IS NOT DISTINCT FROM $7::text
           AND task_ids=$8::uuid[] AND has_warnings=$9
           AND warning_reason IS NOT DISTINCT FROM $10::text`,
        values,
      );
      if (!exact.rowCount) throw new Error("Channex availability receipt conflict");
      await client.query("COMMIT");
      committed = true;
      return { kind: "retained" as const, receiptId: scope.receiptId };
    } finally {
      if (!committed)
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
      client.release(discard);
    }
  };
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
