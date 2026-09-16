import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import {
  claimChannexRoomAvailability,
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
    async dispatch(
      post: (request: AvailabilityRequest, signal: AbortSignal) => Promise<Response>,
    ) {
      if (used) return { kind: "unavailable" as const, reason: "dispatch_already_used" };
      used = true;
      const current = await verifyChannexRoomAvailabilityDispatch(
        pool,
        inventory,
        lease,
        selection,
        claimed,
      );
      if (current.kind !== "availability_dispatch_verified")
        return { kind: "unavailable" as const, reason: "availability_dispatch_stale" };
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
