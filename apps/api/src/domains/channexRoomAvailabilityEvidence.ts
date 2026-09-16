import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
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

async function readChannexRoomAvailability(
  pool: Pool,
  inventory: Pick<PmsInventoryMaterializationRepository, "getCurrentInventoryDay">,
  input: ChannexPricingJobLeaseInput,
  selection: Readonly<{ roomTypeId: string; date: string }>,
  mode: "evidence" | "claim",
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
      if (!guarded || !current || mode !== "claim") return guarded;
      const request = {
        method: "POST" as const,
        path: "/api/v1/availability" as const,
        body: {
          values: [
            {
              property_id: current.authority.externalPropertyId,
              room_type_id: current.mapping.externalRoomTypeId,
              date_from: selected.date,
              date_to: selected.date,
              availability: day.day.availableCount,
            },
          ],
        },
      };
      const created = (
        await currentClient.query<{ attemptId: string; jobAttemptId: string; workerId: string }>(
          `INSERT INTO pms.channex_room_availability_attempts
             (mapping_id,job_attempt_id,worker_id,service_date,available_count,
              inventory_evidence,request_body)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
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
