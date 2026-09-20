import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import {
  prepareNextChannexInitialAriDispatch,
  readPublishedPricingForChannexJob,
} from "./replacementPricingOfferOwners.js";

type Prepared = Extract<
  Awaited<ReturnType<typeof prepareNextChannexInitialAriDispatch>>,
  { kind: "prepared" }
>;

/** One newly prepared upload per run, using only persisted property/target identities. */
export async function dispatchNextChannexClosedUpload(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  ports: Parameters<Prepared["dispatch"]>[0],
) {
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  const candidates = await pool.query<{
    creationAttemptId: string;
    roomTypeId: string;
    offerId: string;
    operationKey: string;
    primaryOccupancy: number;
  }>(
    `SELECT a.id AS "creationAttemptId", t.room_type_id AS "roomTypeId", t.offer_id AS "offerId",
       i.operation_key AS "operationKey", i.proposal->'primaryOccupancy' AS "primaryOccupancy"
     FROM pms.channex_offer_create_attempts a
     JOIN pms.channex_offer_targets t ON t.id=a.target_id
     JOIN pms.channex_offer_target_intents i ON i.id=a.intent_id
     WHERE t.property_id=$1 AND a.state='identified' AND i.status='pending'
     ORDER BY a.created_at,a.id`,
    [current.authority.lease.propertyId],
  );
  for (const candidate of candidates.rows) {
    const prepared = await prepareNextChannexInitialAriDispatch(
      pool,
      lease,
      candidate,
      candidate.creationAttemptId,
    );
    if (prepared.kind === "initial_dates_reconciled") continue;
    if (prepared.kind !== "prepared") return prepared;
    const result = await prepared.dispatch(ports);
    if (result.kind === "receipt_pending") {
      // Persistence may retry; the consumed dispatch must never be invoked again.
      await result.persist();
      return { kind: "retained" as const, attemptId: result.attemptId };
    }
    return result;
  }
  return { kind: "no_closed_upload" as const };
}
