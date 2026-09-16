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
  let guarded = false;
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
      guarded = isDeepStrictEqual(
        initial,
        await lockRoom(currentClient, lease, selected.roomTypeId),
      );
      return guarded;
    },
  );
  if (snapshot.kind !== "available") return snapshot;
  if (!guarded) return { kind: "unavailable" as const, reason: "consumer_authority_unavailable" };
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
    }>(
      `SELECT m.id::text AS "mappingId",m.external_room_type_id AS "externalRoomTypeId",c.binding_generation::text AS "bindingGeneration"
     FROM pms.channel_room_type_mappings m JOIN pms.channel_connections c ON c.id=m.connection_id AND c.property_id=m.property_id
     JOIN pms.room_types r ON r.id=m.room_type_id AND r.property_id=m.property_id
     JOIN platform.jobs j ON j.id=$4::uuid
     WHERE m.property_id=$1 AND m.connection_id=$2 AND m.room_type_id=$3 AND m.status='active' AND r.active
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
