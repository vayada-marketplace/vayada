import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { reconcileCurrentChannexRoomAvailability } from "./channexRoomAvailabilityEvidence.js";
import { supersedeChannexRoomAvailabilityAttempt } from "./channexRoomAvailabilitySupersede.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";

type Inventory = Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">;

/** Discovers retained availability writes from current lease authority, never caller IDs. */
export async function reconcilePendingChannexRoomAvailability(
  pool: Pool,
  inventory: Inventory,
  input: ChannexPricingJobLeaseInput,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const lease = { ...input };
  const client = await pool.connect();
  let committed = false,
    discard = false;
  let candidates: ReadonlyArray<{
    attemptId: string;
    roomTypeId: string;
    date: string;
    admissible: boolean;
  }> = [];
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const authority = await lockChannexPricingPropertyAuthority(client, lease);
    if (
      authority.kind !== "authorized" ||
      (authority.lease.operationType !== "sync_ari" && !authority.lease.publishedOfferProvisioning)
    )
      return { kind: "unavailable" as const, reason: "availability_authority_unavailable" };
    candidates = (
      await client.query<{
        attemptId: string;
        roomTypeId: string;
        date: string;
        admissible: boolean;
      }>(
        `SELECT attempt.id::text AS "attemptId",attempt.room_type_id::text AS "roomTypeId",
           attempt.service_date::text AS date,
           count(receipt.id)=1 AND bool_and(
             receipt.outcome='complete_json' AND receipt.http_status=200
             AND NOT receipt.has_warnings AND receipt.warning_reason IS NULL
             AND cardinality(receipt.task_ids) BETWEEN 1 AND 100
             AND cardinality(receipt.task_ids)=(
               SELECT count(DISTINCT task) FROM unnest(receipt.task_ids) task)
           ) AS admissible
         FROM pms.channex_room_availability_attempts attempt
         LEFT JOIN pms.channex_room_availability_receipts receipt
           ON receipt.attempt_id=attempt.id AND receipt.job_attempt_id=attempt.job_attempt_id
          AND receipt.worker_id=attempt.worker_id
         WHERE attempt.property_id=$1 AND attempt.state='unresolved'
         GROUP BY attempt.id,attempt.room_type_id,attempt.service_date,attempt.created_at
         ORDER BY attempt.created_at,attempt.id LIMIT 11`,
        [authority.lease.propertyId],
      )
    ).rows;
    await client.query("COMMIT");
    committed = true;
  } finally {
    if (!committed)
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    client.release(discard);
  }
  for (const candidate of candidates.slice(0, 10)) {
    // VAY-2352: a send that can never be reconciled as current would block its room and every
    // later sync of the hotel. Supersede it when its night changed or passed, or once an
    // ambiguous send has settled; the current value is then sent in this same run.
    const result = candidate.admissible
      ? await reconcileCurrentChannexRoomAvailability(
          pool,
          inventory,
          lease,
          { roomTypeId: candidate.roomTypeId, date: candidate.date },
          candidate.attemptId,
          get,
        )
      : ({ kind: "unavailable", reason: "availability_receipt_history_unavailable" } as const);
    if (result.kind === "availability_reconciled") continue;
    const superseded = await supersedeChannexRoomAvailabilityAttempt(
      pool,
      inventory,
      lease,
      candidate.attemptId,
      get,
    );
    if (
      superseded.kind === "availability_superseded" ||
      superseded.kind === "availability_attempt_resolved"
    )
      continue;
    // A lost response is only resent once Channex can no longer be taking the first request in.
    if (superseded.kind === "availability_send_settling")
      return { kind: "unavailable" as const, reason: "availability_send_settling" };
    return result;
  }
  return candidates.length > 10
    ? { kind: "unavailable" as const, reason: "availability_reconciliation_batch_pending" }
    : { kind: "pending_availability_reconciled" as const, count: candidates.length };
}
