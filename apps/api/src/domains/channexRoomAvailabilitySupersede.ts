import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { observeChannexAvailabilityTaskEnd } from "../integrations/channexAriTaskReadback.js";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";
import { boundedProviderCall } from "./channexRoomAvailabilityEvidence.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";

type Inventory = Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">;

type UnresolvedAttempt = {
  roomTypeId: string;
  date: string;
  externalPropertyId: string;
  request: unknown;
  inventoryEvidenceSha256: string;
  timeZone: string | null;
  now: Date;
  receiptId: string | null;
  receiptOutcome: string | null;
  receiptCount: number;
  taskIds: string[];
  clean: boolean;
  ambiguous: boolean;
  settled: boolean;
};

/**
 * VAY-2352: resolves an unresolved availability send that can never be reconciled as current.
 * Left unresolved, it blocks its Channex room (one unresolved send per room) and fails every later
 * sync of the hotel. It is superseded (reconciled without an attestation, so it never counts as
 * current coverage) when:
 * - its night has passed in the hotel's time zone: nothing is sent for that night again;
 * - its night changed since the send: its Channex task has ended (successfully or not) with
 *   exactly the request it sent, so the current value, sent next, can't be overtaken by it;
 * - its outcome is unknown (timeout, cut-off or unreadable response, crash before the receipt):
 *   after a settle window for a request Channex may still be taking in; the current value is
 *   then sent again. Availability values are absolute, so a repeat sets the same count.
 * A definite Channex refusal (4xx, a response with warnings) is left as it is: resending the same
 * value would only be refused again, and someone has to look at it.
 */
export async function supersedeChannexRoomAvailabilityAttempt(
  pool: Pool,
  inventory: Inventory,
  input: ChannexPricingJobLeaseInput,
  attemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const lease = { ...input };
  const read = await inTransaction(pool, async (client) => {
    const authority = await lockAvailabilityAuthority(client, lease);
    if (!authority) return null;
    const attempt = (
      await client.query<UnresolvedAttempt>(
        `SELECT a.room_type_id::text AS "roomTypeId",a.service_date::text AS date,
           a.external_property_id AS "externalPropertyId",a.request_body AS request,
           a.inventory_evidence_sha256 AS "inventoryEvidenceSha256",
           a.inventory_evidence->>'propertyTimeZone' AS "timeZone",clock_timestamp() AS now,
           r.id::text AS "receiptId",r.outcome AS "receiptOutcome",
           (r.id IS NOT NULL)::int AS "receiptCount",
           COALESCE(r.task_ids::text[],'{}') AS "taskIds",
           COALESCE(r.outcome='complete_json' AND r.http_status=200 AND NOT r.has_warnings
             AND r.warning_reason IS NULL AND cardinality(r.task_ids) BETWEEN 1 AND 100
             AND cardinality(r.task_ids)=(SELECT count(DISTINCT task) FROM unnest(r.task_ids) task),
             false) AS clean,
           -- No receipt, no answer, a server-side failure, or a 2xx answer we couldn't read.
           (r.id IS NULL OR r.outcome IN ('transport_error','body_interrupted')
             OR r.http_status IN (408,429) OR r.http_status>=500
             OR (r.http_status BETWEEN 200 AND 299 AND (r.outcome IN ('invalid_json','body_limit')
               OR r.warning_reason IN ('invalid_tasks','invalid_meta','invalid_warnings'))))
             AS ambiguous,
           -- The POST ends by its 15 s deadline. With a receipt, or once the sending job attempt
           -- has ended, 10 s more lets a request Channex was still taking in land first. Without
           -- either, the sending worker died and its job's 5-minute lease bounds the send.
           CASE WHEN r.id IS NOT NULL THEN r.captured_at<=clock_timestamp()-interval '10 seconds'
             ELSE a.created_at<=clock_timestamp()-interval '5 minutes'
               OR sender.finished_at<=clock_timestamp()-interval '10 seconds' END AS settled
         FROM pms.channex_room_availability_attempts a
         LEFT JOIN pms.channex_room_availability_receipts r ON r.attempt_id=a.id
         LEFT JOIN platform.job_attempts sender ON sender.id=a.job_attempt_id
         WHERE a.id=$1 AND a.property_id=$2 AND a.state='unresolved'`,
        [attemptId, authority.propertyId],
      )
    ).rows[0];
    return { attempt, ...authority };
  });
  if (!read) return unavailable("availability_supersede_unavailable");
  const { attempt } = read;
  if (!attempt) return { kind: "availability_attempt_resolved" as const };

  const localToday = channexPropertyLocalDate(attempt.timeZone, attempt.now);
  let reason: "service_date_passed" | "inventory_changed" | "receipt_ambiguous";
  if (localToday && attempt.date < localToday) reason = "service_date_passed";
  else if (attempt.clean) {
    let changed = false;
    const current = await inventory.getCurrentInventoryDay(
      {
        propertyId: read.propertyId,
        roomTypeId: attempt.roomTypeId,
        stayDate: attempt.date,
        materializationScope: read.provisioning ? "room" : "property",
      },
      async (_client, day) => {
        changed = hash(day) !== attempt.inventoryEvidenceSha256;
        return true;
      },
    );
    // A night that can't be read now is not proven stale; the exact reconciliation keeps it.
    if (current.kind !== "available" || !changed)
      return unavailable("availability_supersede_unavailable");
    reason = "inventory_changed";
  } else if (attempt.ambiguous) {
    if (!attempt.settled) return { kind: "availability_send_settling" as const };
    reason = "receipt_ambiguous";
  } else return unavailable("availability_supersede_unavailable");

  let tasks: Awaited<ReturnType<typeof observeChannexAvailabilityTaskEnd>>[] = [];
  if (reason === "inventory_changed")
    tasks = await boundedProviderCall(async (signal) => {
      const observe = (_method: "GET", path: string) => {
        signal.throwIfAborted();
        return get(path, signal);
      };
      const ended = [];
      for (const taskId of attempt.taskIds)
        ended.push(
          await observeChannexAvailabilityTaskEnd(
            { taskId, externalPropertyId: attempt.externalPropertyId, request: attempt.request },
            observe,
          ),
        );
      return ended;
    });

  const evidence = {
    schemaVersion: 1,
    resolution: "superseded",
    reason,
    originalReceiptId: attempt.receiptId,
    receiptOutcome: attempt.receiptOutcome,
    taskCount: tasks.length,
    tasksSucceeded: tasks.length ? tasks.every((task) => task.success === true) : null,
    observationsSha256: tasks.length ? hash({ tasks }) : null,
    inventoryEvidenceSha256: attempt.inventoryEvidenceSha256,
  };
  const saved = await inTransaction(pool, async (client) => {
    const authority = await lockAvailabilityAuthority(client, lease);
    if (!authority || authority.propertyId !== read.propertyId) return null;
    const locked = await client.query<{ receiptCount: number }>(
      `SELECT (SELECT count(*)::int FROM pms.channex_room_availability_receipts r
               WHERE r.attempt_id=a.id) AS "receiptCount"
       FROM pms.channex_room_availability_attempts a
       WHERE a.id=$1 AND a.property_id=$2 AND a.state='unresolved'
       FOR UPDATE OF a NOWAIT`,
      [attemptId, read.propertyId],
    );
    if (!locked.rowCount) return "resolved" as const;
    if (locked.rows[0]!.receiptCount !== attempt.receiptCount) return null;
    await client.query(
      `UPDATE pms.channex_room_availability_attempts
       SET state='reconciled',reconciliation_evidence=$2::jsonb
       WHERE id=$1 AND state='unresolved'`,
      [attemptId, JSON.stringify(evidence)],
    );
    return "superseded" as const;
  });
  if (saved === "superseded")
    return { kind: "availability_superseded" as const, attemptId, reason };
  if (saved === "resolved") return { kind: "availability_attempt_resolved" as const };
  return unavailable("availability_supersede_unavailable");
}

async function lockAvailabilityAuthority(client: PoolClient, lease: ChannexPricingJobLeaseInput) {
  const authority = await lockChannexPricingPropertyAuthority(client, lease);
  if (
    authority.kind !== "authorized" ||
    (authority.lease.operationType !== "sync_ari" && !authority.lease.publishedOfferProvisioning)
  )
    return null;
  return {
    propertyId: authority.lease.propertyId,
    provisioning: authority.lease.operationType === "provision",
  };
}

/** Commits only when `work` returns a non-null value; null rolls back. */
async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T | null>) {
  const client = await pool.connect();
  let committed = false,
    discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const result = await work(client);
    if (result !== null) {
      await client.query("COMMIT");
      committed = true;
    }
    return result;
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

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailable(reason: string) {
  return { kind: "unavailable" as const, reason };
}
