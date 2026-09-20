import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { verifyChannexAvailabilityTaskFinish } from "../integrations/channexAriTaskReadback.js";
import { verifyChannexRoomAvailability } from "../integrations/channexAvailabilityReadback.js";
import type {
  ChannexPricingJobLeaseInput,
  ChannexPricingQueryClient,
} from "../jobs/pmsChannexPricingJobLease.js";
import type { PmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { admitChannexInitialAriDate } from "./channexInitialAriDate.js";

/** Committed current evidence only, never a recovered or new provider send permit. */
export async function prepareChannexRoomAvailabilityEvidence(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
) {
  return readChannexRoomAvailability(pool, inventory, input, selection, "evidence");
}

/** Commits local room/date ownership only; provider dispatch remains separate. */
export async function claimChannexRoomAvailability(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
) {
  return readChannexRoomAvailability(pool, inventory, input, selection, "claim");
}

export type ChannexRoomAvailabilityClaim = Extract<
  Awaited<ReturnType<typeof claimChannexRoomAvailability>>,
  { kind: "availability_claimed" }
>;

/** Final atomic day, authority, request and unresolved-owner gate before POST. */
export async function verifyChannexRoomAvailabilityDispatch(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
  claim: ChannexRoomAvailabilityClaim,
) {
  return readChannexRoomAvailability(pool, inventory, input, selection, "dispatch", claim);
}

/** Reconciles one retained write from exact task, provider and current PMS evidence. */
export async function reconcileCurrentChannexRoomAvailability(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
  attemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  if (!uuid(attemptId)) return { kind: "unavailable" as const, reason: "invalid_attempt" };
  const before = await readChannexRoomAvailability(pool, inventory, input, selection, "reconcile", {
    attemptId,
  });
  if (before.kind !== "availability_reconciliation_current") return before;
  const observations = await boundedProviderCall(async (signal) => {
    const read = (_method: "GET", path: string) => {
      signal.throwIfAborted();
      return get(path, signal);
    };
    const tasks = [];
    for (const taskId of before.taskIds) {
      signal.throwIfAborted();
      tasks.push(
        await verifyChannexAvailabilityTaskFinish(
          {
            taskId,
            externalPropertyId: before.authority.externalPropertyId,
            request: before.request,
          },
          read,
        ),
      );
    }
    const availability = await verifyChannexRoomAvailability(before.request, read);
    return {
      schemaVersion: 1,
      completionBasis: "finished_task_fifo",
      originalReceiptId: before.receiptId,
      taskCount: tasks.length,
      observationsSha256: hash({ tasks, availability }),
      inventoryEvidenceSha256: hash(before.inventory),
      availability,
    };
  });
  const after = await readChannexRoomAvailability(pool, inventory, input, selection, "reconcile", {
    attemptId,
    before,
    observations,
  });
  return after.kind === "availability_reconciliation_current"
    ? { kind: "availability_reconciled" as const, attemptId }
    : after;
}

type ReconciliationWork = Readonly<{
  attemptId: string;
  before?: ReconciliationCandidate;
  observations?: Readonly<Record<string, unknown>>;
}>;

type ReconciliationCandidate = Readonly<{
  kind: "availability_reconciliation_current";
  authority: NonNullable<Awaited<ReturnType<typeof lockRoom>>>["authority"];
  mapping: NonNullable<Awaited<ReturnType<typeof lockRoom>>>["mapping"];
  inventory: Extract<
    Awaited<ReturnType<PmsInventoryMaterializationRepository["getCurrentInventoryDay"]>>,
    { kind: "available" }
  >;
  attemptId: string;
  receiptId: string;
  taskIds: readonly string[];
  request: unknown;
}>;

async function readChannexRoomAvailability(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
  mode: "evidence" | "claim" | "dispatch" | "reconcile",
  expected?: ChannexRoomAvailabilityClaim | ReconciliationWork,
) {
  const lease = { ...input },
    selected = { ...selection };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected.roomTypeId))
    return { kind: "unavailable" as const, reason: "invalid_room" };
  const client = await pool.connect();
  let initial: Awaited<ReturnType<typeof lockRoom>>;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    initial = await lockRoom(client, lease, selected.roomTypeId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!initial) return { kind: "unavailable" as const, reason: "room_authority_unavailable" };
  let guarded = false,
    claimUnavailable = false,
    claim:
      | Readonly<{
          attemptId: string;
          jobAttemptId: string;
          workerId: string;
          request: Readonly<{ method: "POST"; path: "/api/v1/availability"; body: unknown }>;
        }>
      | undefined,
    reconciliation:
      | Readonly<{
          attemptId: string;
          receiptId: string;
          taskIds: readonly string[];
          request: unknown;
        }>
      | undefined;
  const snapshot = await inventory.getCurrentInventoryDay(
    {
      propertyId: initial.authority.lease.propertyId,
      roomTypeId: selected.roomTypeId,
      stayDate: selected.date,
    },
    async (currentClient, day) => {
      if (
        day.day.propertyId !== initial.authority.lease.propertyId ||
        day.day.roomTypeId !== selected.roomTypeId ||
        day.day.stayDate !== selected.date
      )
        return false;
      const now = (await currentClient.query("SELECT clock_timestamp() AS now")).rows[0]
        .now as Date;
      if (admitChannexInitialAriDate(selected.date, day.propertyTimeZone, now).kind !== "admitted")
        return false;
      const current = await lockRoom(currentClient, lease, selected.roomTypeId);
      guarded = isDeepStrictEqual(initial, current);
      if (!guarded || !current) return false;
      const request = availabilityRequest(current, selected.date, day.day.availableCount);
      if (mode === "reconcile") {
        const work = expected as ReconciliationWork | undefined;
        const row = (
          await currentClient.query<{
            attemptId: string;
            receiptId: string;
            taskIds: string[];
            request: unknown;
          }>(
            `SELECT a.id::text AS "attemptId",r.id::text AS "receiptId",
               r.task_ids::text[] AS "taskIds",a.request_body AS request
             FROM pms.channex_room_availability_attempts a
             JOIN pms.channex_room_availability_receipts r
               ON r.attempt_id=a.id AND r.job_attempt_id=a.job_attempt_id
              AND r.worker_id=a.worker_id
             WHERE a.id=$1 AND a.state='unresolved' AND a.property_id=$2
               AND a.connection_id=$3 AND a.mapping_id=$4 AND a.binding_generation=$5
               AND a.room_type_id=$6 AND a.external_property_id=$7
               AND a.external_room_type_id=$8 AND a.service_date=$9
               AND a.available_count=$10 AND a.inventory_evidence=$11::jsonb
               AND a.request_body=$12::jsonb AND r.outcome='complete_json'
               AND r.http_status=200 AND NOT r.has_warnings AND r.warning_reason IS NULL
               AND cardinality(r.task_ids) BETWEEN 1 AND 100
               AND cardinality(r.task_ids)=(SELECT count(DISTINCT task) FROM unnest(r.task_ids) task)
             FOR UPDATE OF a NOWAIT`,
            [
              work?.attemptId,
              current.authority.lease.propertyId,
              current.authority.connectionId,
              current.mapping.mappingId,
              current.mapping.bindingGeneration,
              selected.roomTypeId,
              current.authority.externalPropertyId,
              current.mapping.externalRoomTypeId,
              selected.date,
              day.day.availableCount,
              JSON.stringify(day),
              JSON.stringify(request.body),
            ],
          )
        ).rows[0];
        reconciliation = row;
        if (!row) return false;
        const candidate = {
          kind: "availability_reconciliation_current" as const,
          authority: current.authority,
          mapping: current.mapping,
          inventory: day,
          ...row,
        };
        if (work?.before && !isDeepStrictEqual(work.before, candidate)) return false;
        if (work?.observations) {
          const inventoryDigest = hash(day);
          if (
            work.observations.inventoryEvidenceSha256 !== inventoryDigest ||
            typeof work.observations.observationsSha256 !== "string"
          )
            return false;
          const attested = await currentClient.query(
            `INSERT INTO pms.channex_room_availability_reconciliation_attestations
               (attempt_id,receipt_id,inventory_evidence_sha256,observations_sha256,
                reconciliation_evidence)
             SELECT a.id,$2,a.inventory_evidence_sha256,$3,$4::jsonb
             FROM pms.channex_room_availability_attempts a
             WHERE a.id=$1 AND a.state='unresolved'
               AND a.inventory_evidence_sha256=$5
             ON CONFLICT DO NOTHING RETURNING attempt_id`,
            [
              row.attemptId,
              row.receiptId,
              work.observations.observationsSha256,
              JSON.stringify(work.observations),
              inventoryDigest,
            ],
          );
          if (!attested.rowCount) return false;
          const saved = await currentClient.query(
            `UPDATE pms.channex_room_availability_attempts
             SET state='reconciled',reconciliation_evidence=$2::jsonb
             WHERE id=$1 AND state='unresolved' RETURNING id`,
            [row.attemptId, JSON.stringify(work.observations)],
          );
          if (!saved.rowCount) return false;
          const final = await lockRoom(currentClient, lease, selected.roomTypeId);
          guarded = isDeepStrictEqual(current, final);
          return guarded;
        }
        return true;
      }
      if (mode === "dispatch") {
        const dispatch = expected as ChannexRoomAvailabilityClaim | undefined;
        guarded = Boolean(
          dispatch &&
          isDeepStrictEqual(dispatch.authority, current.authority) &&
          isDeepStrictEqual(dispatch.mapping, current.mapping) &&
          isDeepStrictEqual(dispatch.inventory, day) &&
          (
            await currentClient.query(
              `SELECT id FROM pms.channex_room_availability_attempts a
                 WHERE a.id=$1 AND a.job_attempt_id=$2 AND a.worker_id=$3
                   AND a.property_id=$4 AND a.connection_id=$5 AND a.mapping_id=$6
                   AND a.binding_generation=$7 AND a.external_property_id=$8
                   AND a.external_room_type_id=$9 AND a.service_date=$10
                   AND a.available_count=$11 AND a.request_body=$12::jsonb AND a.state='unresolved'
                   AND NOT EXISTS (SELECT 1 FROM pms.channex_room_availability_receipts r WHERE r.attempt_id=a.id)
                 FOR SHARE OF a NOWAIT`,
              [
                dispatch.attemptId,
                dispatch.jobAttemptId,
                dispatch.workerId,
                current.authority.lease.propertyId,
                current.authority.connectionId,
                current.mapping.mappingId,
                current.mapping.bindingGeneration,
                current.authority.externalPropertyId,
                current.mapping.externalRoomTypeId,
                selected.date,
                day.day.availableCount,
                JSON.stringify(dispatch.request.body),
              ],
            )
          ).rowCount,
        );
        return guarded;
      }
      if (mode !== "claim") return true;
      const created = (
        await currentClient.query<{ attemptId: string; jobAttemptId: string; workerId: string }>(
          `INSERT INTO pms.channex_room_availability_attempts
             (mapping_id,job_attempt_id,worker_id,service_date,available_count,
              inventory_evidence,request_body,inventory_evidence_sha256)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
           ON CONFLICT (external_property_id,external_room_type_id) WHERE state='unresolved'
           DO NOTHING
           RETURNING id::text AS "attemptId",job_attempt_id::text AS "jobAttemptId",
             worker_id AS "workerId"`,
          [
            current.mapping.mappingId,
            current.mapping.jobAttemptId,
            lease.workerId,
            selected.date,
            day.day.availableCount,
            JSON.stringify(day),
            JSON.stringify(request.body),
            hash(day),
          ],
        )
      ).rows[0];
      if (!created) {
        claimUnavailable = true;
        return false;
      }
      claim = { ...created, request };
      return guarded;
    },
  );
  if (snapshot.kind !== "available")
    return claimUnavailable
      ? { kind: "unavailable" as const, reason: "availability_reconciliation_required" }
      : snapshot;
  if (!guarded) return { kind: "unavailable" as const, reason: "consumer_authority_unavailable" };
  if (mode === "reconcile") {
    if (!reconciliation)
      return { kind: "unavailable" as const, reason: "availability_reconciliation_unavailable" };
    return {
      kind: "availability_reconciliation_current" as const,
      authority: initial.authority,
      mapping: initial.mapping,
      inventory: snapshot,
      ...reconciliation,
    };
  }
  if (mode === "dispatch") return { kind: "availability_dispatch_verified" as const };
  if (mode === "claim") {
    if (!claim) return { kind: "unavailable" as const, reason: "availability_claim_unavailable" };
    return {
      kind: "availability_claimed" as const,
      authority: initial.authority,
      mapping: initial.mapping,
      inventory: snapshot,
      ...claim,
    };
  }
  return {
    kind: "availability_prepared" as const,
    authority: initial.authority,
    mapping: initial.mapping,
    inventory: snapshot,
  };
}

function availabilityRequest(
  current: NonNullable<Awaited<ReturnType<typeof lockRoom>>>,
  date: string,
  availableCount: number,
) {
  return {
    method: "POST" as const,
    path: "/api/v1/availability" as const,
    body: {
      values: [
        {
          property_id: current.authority.externalPropertyId,
          room_type_id: current.mapping.externalRoomTypeId,
          date_from: date,
          date_to: date,
          availability: availableCount,
        },
      ],
    },
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

async function boundedProviderCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Channex availability reconciliation deadline"));
    }, 15_000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function lockRoom(
  client: ChannexPricingQueryClient,
  lease: ChannexPricingJobLeaseInput,
  roomTypeId: string,
) {
  const authority = await lockChannexPricingPropertyAuthority(client, lease);
  if (authority.kind !== "authorized" || authority.lease.operationType !== "sync_ari") return null;
  const mapping = (
    await client.query<{
      mappingId: string;
      externalRoomTypeId: string;
      bindingGeneration: string;
      jobAttemptId: string;
    }>(
      `SELECT m.id::text AS "mappingId",m.external_room_type_id AS "externalRoomTypeId",
        c.binding_generation::text AS "bindingGeneration",a.id::text AS "jobAttemptId"
     FROM pms.channel_room_type_mappings m JOIN pms.channel_connections c ON c.id=m.connection_id AND c.property_id=m.property_id
     JOIN pms.room_types r ON r.id=m.room_type_id AND r.property_id=m.property_id
     JOIN platform.jobs j ON j.id=$4::uuid
     JOIN platform.job_attempts a ON a.job_id=j.id AND a.attempt_number=j.attempts_count AND a.worker_id=j.locked_by
     WHERE m.property_id=$1 AND m.connection_id=$2 AND m.room_type_id=$3 AND m.status='active' AND r.active
       AND c.connection_status='connected' AND c.external_property_id IS NOT NULL
       AND c.external_property_id<>'' AND c.external_property_id=btrim(c.external_property_id)
       AND COALESCE(j.payload->'restrictionsOnly','false'::jsonb)='false'::jsonb
       AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closed WHERE closed.room_type_id=r.id AND closed.property_id=r.property_id)
     FOR SHARE OF m,c,r NOWAIT`,
      [authority.lease.propertyId, authority.connectionId, roomTypeId, lease.jobId],
    )
  ).rows[0];
  if (
    !mapping ||
    !mapping.externalRoomTypeId ||
    mapping.externalRoomTypeId.trim() !== mapping.externalRoomTypeId
  )
    return null;
  const final = await lockChannexPricingPropertyAuthority(client, lease);
  return isDeepStrictEqual(authority, final) ? { authority, mapping } : null;
}
