import type { Pool, PoolClient } from "pg";
import {
  lockChannexPricingJobLease,
  type ChannexPricingJobLeaseInput,
} from "../jobs/pmsChannexPricingJobLease.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNANSWERED_REPLIES = 3;

type Receipt = {
  outcome: string;
  httpStatus: number | null;
  warningReason: string | null;
  capturedAt: Date;
};

type Upload = {
  serviceDate: string;
  timeZone: string | null;
  createdAt: Date;
  senderLeaseUntil: Date | null;
  senderFinishedAt: Date | null;
  now: Date;
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
 * It is released only once the send has settled: 10 s after a reply was saved; without one, while
 * the sending job attempt no longer holds its lease, 10 s after it ended (or, never marked ended,
 * 5 minutes after the claim: a job lease bounds every send). Until then the caller retries at
 * `retryAfterMs`. A night that has passed in the hotel's zone is released at once: it is never
 * sent again (selectNextChannexInitialAriDate), and a late original can't sell it.
 * A definite refusal (another 4xx, an answer with errors or warnings) or a second reply stays
 * unresolved: the same body would only be refused again, and someone has to look at it. So does
 * a night already released MAX_UNANSWERED_REPLIES times after a reply without an answer: Channex
 * keeps failing it, and resending forever would hide that.
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
           captured_at AS "capturedAt"
         FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1`,
        [ariAttemptId],
      )
    ).rows;
    if (receipts.length > 1 || (receipts.length === 1 && !withoutAnswer(receipts[0]!)))
      return unavailable("ari_reply_kept");
    // As for an offer delivery (channexOfferAriDelivery.ts): while the attempt that claimed the
    // upload still holds its job lease, its POST may still be under way.
    const upload = (
      await client.query<Upload>(
        `SELECT a.service_date::text AS "serviceDate",l.timezone AS "timeZone",
           a.created_at AS "createdAt",clock_timestamp() AS now,
           (SELECT j.locked_at+interval '5 minutes' FROM platform.job_attempts s
              JOIN platform.jobs j ON j.id=s.job_id
             WHERE s.id=a.job_attempt_id AND s.status='running' AND s.finished_at IS NULL
               AND j.status='running' AND j.locked_by=a.worker_id AND j.attempts_count=s.attempt_number
               AND j.locked_at > clock_timestamp() - interval '5 minutes') AS "senderLeaseUntil",
           (SELECT s.finished_at FROM platform.job_attempts s WHERE s.id=a.job_attempt_id)
             AS "senderFinishedAt"
         FROM pms.channex_offer_ari_attempts a
         JOIN pms.channex_offer_targets t ON t.id=a.target_id
         LEFT JOIN hotel_catalog.property_locations l ON l.property_id=t.property_id
         WHERE a.id=$1`,
        [ariAttemptId],
      )
    ).rows[0]!;
    const today = channexPropertyLocalDate(upload.timeZone, upload.now);
    let reason: "night_passed" | "no_reply" | "reply_without_answer";
    if (today && upload.serviceDate < today) reason = "night_passed";
    else {
      const receipt = receipts[0];
      const settlesAt = receipt
        ? seconds(receipt.capturedAt, 10)
        : (upload.senderLeaseUntil ??
          (upload.senderFinishedAt
            ? seconds(upload.senderFinishedAt, 10)
            : seconds(upload.createdAt, 300)));
      const wait = settlesAt.getTime() - upload.now.getTime();
      if (wait > 0)
        return {
          kind: "unavailable" as const,
          reason: "ari_send_settling",
          retryAfterMs: Math.min(301_000, Math.ceil(wait) + 1_000),
        };
      if (receipt) {
        const earlier = (
          await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts a
             JOIN pms.channex_offer_ari_attempts x ON x.external_property_id=a.external_property_id
               AND x.external_rate_plan_id=a.external_rate_plan_id AND x.service_date=a.service_date
             WHERE a.id=$1 AND x.state='released'
               AND EXISTS (SELECT 1 FROM pms.channex_offer_ari_receipts r WHERE r.attempt_id=x.id)`,
            [ariAttemptId],
          )
        ).rows[0]!.count;
        if (earlier >= MAX_UNANSWERED_REPLIES) return unavailable("ari_release_limit");
      }
      reason = receipt ? "reply_without_answer" : "no_reply";
    }
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
    // night_passed is never sent again; the other reasons are, on the next turn.
    console.warn("Channex initial upload released.", {
      jobId: lease.jobId,
      attemptNumber: lease.attemptNumber,
      ariAttemptId,
      reason: result.reason,
    });
  else if (result.kind === "unavailable" && result.reason === "ari_release_limit")
    console.warn("Channex initial upload kept: Channex never answered this night.", {
      jobId: lease.jobId,
      attemptNumber: lease.attemptNumber,
      ariAttemptId,
      releasedReplies: MAX_UNANSWERED_REPLIES,
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

function seconds(from: Date, count: number) {
  return new Date(from.getTime() + count * 1_000);
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
