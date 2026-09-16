import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import {
  claimChannexRoomAvailability,
  type ChannexRoomAvailabilityClaim,
  verifyChannexRoomAvailabilityDispatch,
} from "./channexRoomAvailabilityEvidence.js";
import {
  prepareChannexRoomAvailabilityReceiptPersistence,
  prepareChannexRoomAvailabilityTransportFailurePersistence,
} from "./channexRoomAvailabilityReceiptStore.js";

type AvailabilityRequest = Readonly<{
  method: "POST";
  path: "/api/v1/availability";
  body: unknown;
}>;

/** A fresh claim creates one in-memory send capability; retained attempts are never reopened. */
export async function prepareChannexRoomAvailabilityDispatch(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  lease: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
) {
  const claimed = await claimChannexRoomAvailability(pool, inventory, lease, selection);
  if (claimed.kind !== "availability_claimed") return claimed;
  let used = false;
  return {
    kind: "prepared" as const,
    attemptId: claimed.attemptId,
    async dispatch(post: (request: AvailabilityRequest, signal: AbortSignal) => Promise<Response>) {
      if (used) return { kind: "unavailable" as const, reason: "dispatch_already_used" };
      used = true;
      let current: Awaited<ReturnType<typeof verifyChannexRoomAvailabilityDispatch>>;
      try {
        current = await verifyChannexRoomAvailabilityDispatch(
          pool,
          inventory,
          lease,
          selection,
          claimed,
        );
      } catch {
        await releaseUnsentAvailabilityAttempt(pool, claimed);
        return { kind: "unavailable" as const, reason: "availability_dispatch_stale" };
      }
      if (current.kind !== "availability_dispatch_verified") {
        await releaseUnsentAvailabilityAttempt(pool, claimed);
        return { kind: "unavailable" as const, reason: "availability_dispatch_stale" };
      }
      let response: Response | null = null;
      try {
        response = await boundedCall((signal) => post(structuredClone(claimed.request), signal));
      } catch {
        // Once POST starts, any error is an ambiguous provider mutation.
      }
      const correlation = {
        receiptId: randomUUID(),
        attemptId: claimed.attemptId,
        jobAttemptId: claimed.jobAttemptId,
        workerId: claimed.workerId,
        propertyId: claimed.authority.lease.propertyId,
        connectionId: claimed.authority.connectionId,
      };
      const persist = response
        ? await prepareChannexRoomAvailabilityReceiptPersistence(pool, correlation, response)
        : await prepareChannexRoomAvailabilityTransportFailurePersistence(pool, correlation);
      try {
        await persist();
        return { kind: "retained" as const, attemptId: claimed.attemptId };
      } catch {
        return { kind: "receipt_pending" as const, attemptId: claimed.attemptId, persist };
      }
    },
  };
}

/** Releases only a claim that is still provably receipt-free before POST. */
async function releaseUnsentAvailabilityAttempt(pool: Pool, claim: ChannexRoomAvailabilityClaim) {
  const client = await pool.connect();
  let committed = false,
    discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const values = [
      claim.attemptId,
      claim.jobAttemptId,
      claim.workerId,
      claim.authority.lease.propertyId,
      claim.authority.connectionId,
      claim.mapping.mappingId,
      claim.mapping.bindingGeneration,
      claim.inventory.day.roomTypeId,
      claim.authority.externalPropertyId,
      claim.mapping.externalRoomTypeId,
      claim.inventory.day.stayDate,
      claim.inventory.day.availableCount,
      JSON.stringify(claim.inventory),
      JSON.stringify(claim.request.body),
    ];
    const locked = await client.query(
      `SELECT attempt.id FROM pms.channex_room_availability_attempts attempt
       WHERE attempt.id=$1 AND attempt.job_attempt_id=$2 AND attempt.worker_id=$3
         AND attempt.property_id=$4 AND attempt.connection_id=$5
         AND attempt.mapping_id=$6 AND attempt.binding_generation=$7
         AND attempt.room_type_id=$8 AND attempt.external_property_id=$9
         AND attempt.external_room_type_id=$10 AND attempt.service_date=$11
         AND attempt.available_count=$12 AND attempt.inventory_evidence=$13::jsonb
         AND attempt.request_body=$14::jsonb AND attempt.state='unresolved'
       FOR UPDATE`,
      values,
    );
    if (locked.rowCount)
      await client.query(
        `UPDATE pms.channex_room_availability_attempts attempt
         SET state='not_sent',
             reconciliation_evidence=
               '{"schemaVersion":1,"reason":"pre_dispatch_verification_unavailable"}'::jsonb
         WHERE attempt.id=$1 AND attempt.state='unresolved'
         AND NOT EXISTS (
           SELECT 1 FROM pms.channex_room_availability_receipts receipt
           WHERE receipt.attempt_id=attempt.id
         )`,
        [claim.attemptId],
      );
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
}

async function boundedCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Channex availability request deadline"));
    }, 15_000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}
