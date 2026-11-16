import type { Pool, PoolClient } from "pg";
import {
  lockChannexPricingJobLease,
  type ChannexPricingJobLeaseInput,
} from "../jobs/pmsChannexPricingJobLease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Receipt = {
  outcome: string;
  httpStatus: number | null;
  warningReason: string | null;
  settled: boolean;
};

/**
 * VAY-2108, with VAY-2352's lost-send rule: releases a closed initial upload of a new rate plan
 * that Channex never usably answered, so the next run sends its date again.
 * Unanswered means no saved reply at all (the send step failed or its worker stopped after the
 * claim; Tiga, 2026-11-16), or a reply that holds no answer: no response, a cut-off or unreadable
 * body, 408/425/429 or a 5xx. Left unresolved, the upload holds its rate plan (one unresolved
 * upload per plan) and every later full sync of the hotel stops with invalid_state. A closed
 * upload sets absolute values for one night (stop-sell, rates, stay rules), so a repeat that
 * meets a late original sets that night the same way.
 * It is released only once the send has settled: 10 s after a reply was saved; without one, once
 * the sending job attempt no longer runs (ended at least 10 s ago, or its job lease lapsed).
 * A definite refusal (another 4xx, an answer with errors or warnings) or a second reply stays
 * unresolved: the same body would only be refused again, and someone has to look at it.
 */
export async function releaseUnansweredChannexInitialAri(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  ariAttemptId: string,
) {
  const lease = { ...input };
  if (typeof ariAttemptId !== "string" || !UUID.test(ariAttemptId))
    return unavailable("invalid_attempt");
  const result = await inSerializable(pool, async (client) => {
    const leased = await lockChannexPricingJobLease(client, lease);
    if (!leased) return unavailable("lease_unavailable");
    // Receipt capture locks the same target first, so no reply can land while this decides.
    const locked = await client.query(
      `SELECT a.id FROM pms.channex_offer_ari_attempts a
       JOIN pms.channex_offer_targets t ON t.id=a.target_id
       WHERE a.id=$1 AND t.property_id=$2 AND a.state='unresolved'
       FOR UPDATE OF t,a NOWAIT`,
      [ariAttemptId, leased.propertyId],
    );
    if (!locked.rowCount) return { kind: "ari_attempt_resolved" as const };
    const receipts = (
      await client.query<Receipt>(
        `SELECT outcome,http_status AS "httpStatus",warning_reason AS "warningReason",
           captured_at<=clock_timestamp()-interval '10 seconds' AS settled
         FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1`,
        [ariAttemptId],
      )
    ).rows;
    let reason: "no_reply" | "reply_without_answer";
    if (receipts.length === 0) {
      // As for an offer delivery (channexOfferAriDelivery.ts): while the attempt that claimed the
      // upload still holds its job lease, its POST may still be under way.
      const sender = (
        await client.query<{ running: boolean; endedRecently: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM platform.job_attempts s JOIN platform.jobs j ON j.id=s.job_id
               WHERE s.id=a.job_attempt_id AND s.status='running' AND s.finished_at IS NULL
                 AND j.status='running' AND j.locked_by=a.worker_id AND j.attempts_count=s.attempt_number
                 AND j.locked_at > clock_timestamp() - interval '5 minutes') AS running,
             EXISTS (SELECT 1 FROM platform.job_attempts s WHERE s.id=a.job_attempt_id
               AND s.finished_at > clock_timestamp() - interval '10 seconds') AS "endedRecently"
           FROM pms.channex_offer_ari_attempts a WHERE a.id=$1`,
          [ariAttemptId],
        )
      ).rows[0];
      if (!sender || sender.running || sender.endedRecently)
        return unavailable("ari_send_settling");
      reason = "no_reply";
    } else if (receipts.length === 1 && withoutAnswer(receipts[0]!)) {
      if (!receipts[0]!.settled) return unavailable("ari_send_settling");
      reason = "reply_without_answer";
    } else return unavailable("ari_reply_kept");
    // readChannexInitialAriHistory leaves released uploads out, so the date is sent again.
    const released = await client.query(
      `UPDATE pms.channex_offer_ari_attempts SET state='released'
       WHERE id=$1 AND state='unresolved' RETURNING id`,
      [ariAttemptId],
    );
    return released.rowCount
      ? { kind: "ari_released" as const, ariAttemptId, reason }
      : { kind: "ari_attempt_resolved" as const };
  });
  if (result.kind === "ari_released")
    console.warn("Channex initial upload released to send again.", {
      jobId: lease.jobId,
      attemptNumber: lease.attemptNumber,
      ariAttemptId,
      reason: result.reason,
    });
  return result;
}

/** No reply, or one that can't say whether Channex took the upload (VAY-2352's ambiguous set). */
function withoutAnswer(receipt: Receipt) {
  const status = receipt.httpStatus;
  if (receipt.outcome === "transport_error" || receipt.outcome === "body_interrupted") return true;
  if (status === null) return false;
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return (
    status >= 200 &&
    status < 300 &&
    (receipt.outcome === "invalid_json" ||
      receipt.outcome === "body_limit" ||
      ["invalid_tasks", "invalid_meta", "invalid_warnings"].includes(receipt.warningReason ?? ""))
  );
}

async function inSerializable<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T | ReturnType<typeof unavailable>> {
  const client = await pool.connect();
  let committed = false,
    discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const result = await run(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    // A receipt capture or another turn holds the target: the next job turn decides again.
    const code = (error as { code?: unknown })?.code;
    if (code === "55P03" || code === "40001" || code === "40P01" || code === "57014")
      return unavailable("ari_release_contention");
    throw error;
  } finally {
    if (!committed)
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    client.release(discard);
  }
}

function unavailable(reason: string) {
  return { kind: "unavailable" as const, reason };
}
