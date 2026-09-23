import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import {
  readPublishedPricingForChannexJob,
  reconcileCurrentChannexInitialAri,
} from "./replacementPricingOfferOwners.js";

/** Discover from persisted property ownership, never job-supplied provider/attempt IDs. */
export async function reconcilePendingChannexUploads(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const lease = { ...input };
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  const candidates = (
    await pool.query<{
      attemptId: string;
      creationAttemptId: string;
      roomTypeId: string;
      offerId: string;
      operationKey: string;
      primaryOccupancy: number;
    }>(
      `SELECT a.id AS "attemptId",a.creation_attempt_id AS "creationAttemptId",
       t.room_type_id AS "roomTypeId",t.offer_id AS "offerId",i.operation_key AS "operationKey",
       i.proposal->'primaryOccupancy' AS "primaryOccupancy"
     FROM pms.channex_offer_ari_attempts a
     JOIN pms.channex_offer_targets t ON t.id=a.target_id
     JOIN pms.channex_offer_target_intents i ON i.id=a.intent_id
     WHERE t.property_id=$1 AND a.state='unresolved'
     ORDER BY a.created_at,a.id LIMIT 11`,
      [current.authority.lease.propertyId],
    )
  ).rows;
  for (const candidate of candidates.slice(0, 10)) {
    const result = await reconcileCurrentChannexInitialAri(
      pool,
      lease,
      candidate,
      candidate.creationAttemptId,
      candidate.attemptId,
      get,
    );
    if (result.kind === "ari_reconciled" || result.kind === "ari_retired") continue;
    return result;
  }
  return candidates.length > 10
    ? { kind: "unavailable" as const, reason: "reconciliation_batch_pending" }
    : { kind: "pending_uploads_reconciled" as const, count: candidates.length };
}
