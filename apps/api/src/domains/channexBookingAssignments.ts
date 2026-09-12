import type { PoolClient } from "pg";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { enqueueHostInventoryChanges } from "./pmsHostInventoryEffects.js";

export type ChannexRoomStay = {
  externalRoomTypeId: string;
  externalRatePlanId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};
type Stay = ChannexRoomStay & { roomTypeId: string; ratePlanId: string };
type Assignment = Stay & {
  id: string;
  position: number;
  untouched: boolean;
  cancelable: boolean;
  providerStay: ChannexRoomStay | null;
};
export class ChannexAssignmentConflict extends Error {}
const conflict = () => new ChannexAssignmentConflict("operational_assignment_conflict");

/** Caller holds the property inventory lock and booking/connection locks. */
export async function persistChannexAssignments(
  client: PoolClient,
  input: {
    propertyId: string;
    connectionId: string;
    bookingId: string;
    providerBookingId: string;
    revisionId: string;
    channel: string;
    canceled: boolean;
    rooms: readonly ChannexRoomStay[];
    repair?: boolean;
  },
) {
  const { propertyId, bookingId } = input;
  const existing = (
    await client.query<Assignment>(
      `SELECT id::text,position,room_type_id::text AS "roomTypeId",rate_plan_id::text AS "ratePlanId",
       check_in::text AS "checkIn",check_out::text AS "checkOut",adults,children,
       assignment_payload->'channexStay' AS "providerStay",
       (source='channel' AND assignment_status='pending' AND room_id IS NULL
         AND assignment_payload->>'version'=assignment_payload->>'channexRevision') AS untouched,
       (source='channel' AND assignment_status IN ('pending','assigned')
         AND COALESCE(assignment_payload->>'operationalStatus','confirmed')='confirmed') AS cancelable
     FROM pms.operational_booking_assignments
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid ORDER BY position FOR UPDATE`,
      [propertyId, bookingId],
    )
  ).rows;
  if (input.repair && existing.length) {
    if (
      existing.length !== input.rooms.length ||
      existing.some(
        (row, i) => row.position !== i + 1 || !sameStay(row.providerStay, input.rooms[i]!),
      )
    )
      throw conflict();
    return false;
  }
  const spans: { roomTypeId: string; checkIn: string; checkOut: string }[] = [...existing];
  if (input.canceled) {
    if (existing.some((row) => !row.cancelable)) throw conflict();
    await client.query(
      `UPDATE pms.operational_booking_assignments SET assignment_status='canceled',room_id=NULL,assigned_at=NULL,
        assignment_payload=assignment_payload||jsonb_build_object('version',$3::text,'operationalStatus','canceled'),updated_at=now()
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
      [propertyId, bookingId, input.revisionId],
    );
  } else {
    const stays: Stay[] = [];
    for (const room of input.rooms) {
      const mapped = (
        await client.query<{ roomTypeId: string; ratePlanId: string }>(
          `SELECT r.id::text AS "roomTypeId",rate.id::text AS "ratePlanId"
         FROM pms.channel_room_type_mappings rm
         JOIN pms.channel_rate_plan_mappings pm ON pm.connection_id=rm.connection_id
           AND pm.property_id=rm.property_id AND pm.room_type_id=rm.room_type_id
           AND pm.external_room_type_id=rm.external_room_type_id
         JOIN pms.room_types r ON r.id=rm.room_type_id AND r.property_id=rm.property_id
         JOIN pms.rate_plans rate ON rate.id=pm.rate_plan_id AND rate.property_id=r.property_id AND rate.room_type_id=r.id
         WHERE rm.property_id=$1::uuid AND rm.connection_id=$2::uuid
           AND rm.external_room_type_id=$3 AND pm.external_rate_plan_id=$4
           AND rm.status='active' AND pm.status='active' AND r.active AND rate.active
           AND NOT EXISTS(SELECT 1 FROM pms.room_type_closures c WHERE c.property_id=r.property_id AND c.room_type_id=r.id)
         FOR SHARE OF rm,pm,r,rate`,
          [propertyId, input.connectionId, room.externalRoomTypeId, room.externalRatePlanId],
        )
      ).rows;
      if (mapped.length !== 1)
        throw new ChannexAssignmentConflict("operational_mapping_unavailable");
      stays.push({ ...room, ...mapped[0]! });
    }
    const changed =
      existing.length !== stays.length ||
      existing.some(
        (row, i) =>
          row.position !== i + 1 ||
          !sameStay(row.providerStay, stays[i]!) ||
          (row.untouched &&
            (row.roomTypeId !== stays[i]?.roomTypeId || row.ratePlanId !== stays[i]?.ratePlanId)),
      );
    if (!changed) return false;
    if (existing.some((row) => !row.untouched)) throw conflict();
    for (const stay of stays) {
      const closed = await client.query(
        `SELECT 1 FROM pms.inventory_days WHERE property_id=$1::uuid AND room_type_id=$2::uuid
         AND stay_date >= $3::date AND stay_date < $4::date AND (status='closed' OR linked_stop_sell) LIMIT 1`,
        [propertyId, stay.roomTypeId, stay.checkIn, stay.checkOut],
      );
      if (closed.rowCount) throw new ChannexAssignmentConflict("operational_inventory_closed");
    }
    await client.query(
      "DELETE FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND position>$3",
      [propertyId, bookingId, stays.length],
    );
    for (const [index, stay] of stays.entries()) {
      const payload = {
        contractVersion: "channex-operational-assignment.v1",
        channexStay: input.rooms[index],
        channexRevision: input.revisionId,
        version: input.revisionId,
      };
      await client.query(
        `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,rate_plan_id,
          position,assignment_status,channel,source,assignment_payload,stay_evidence_kind,check_in,check_out,adults,children,external_reservation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'pending',$6,'channel',$7::jsonb,'exact',$8::date,$9::date,$10,$11,$12)
         ON CONFLICT(guest_booking_id,position) DO UPDATE SET room_type_id=EXCLUDED.room_type_id,rate_plan_id=EXCLUDED.rate_plan_id,
          assignment_payload=pms.operational_booking_assignments.assignment_payload||EXCLUDED.assignment_payload,
          check_in=EXCLUDED.check_in,check_out=EXCLUDED.check_out,adults=EXCLUDED.adults,children=EXCLUDED.children,updated_at=now()`,
        [
          propertyId,
          bookingId,
          stay.roomTypeId,
          stay.ratePlanId,
          index + 1,
          input.channel,
          payload,
          stay.checkIn,
          stay.checkOut,
          stay.adults,
          stay.children,
          input.providerBookingId,
        ],
      );
    }
    spans.push(...stays);
  }
  const now = new Date();
  await reconcilePmsOccupiedInventory(client, propertyId, spans, now.toISOString());
  const linked = await reconcilePmsLinkedInventory(client, propertyId, now.toISOString());
  await enqueuePmsLinkedInventorySideEffects(
    client,
    {
      propertyId,
      operation: "channex_booking",
      commandId: input.revisionId,
      keyHash: input.revisionId,
      acceptedAt: now.toISOString(),
      audit: { requestId: input.revisionId },
    },
    linked,
  );
  await enqueueHostInventoryChanges(
    client,
    {
      propertyId,
      previewId: `channex:${bookingId}:${input.revisionId}`,
      fingerprint: input.revisionId,
      occurredAt: now,
    },
    spans,
  );
  return true;
}

function sameStay(a: ChannexRoomStay | null, b: ChannexRoomStay): boolean {
  return Boolean(
    a &&
    b &&
    a.externalRoomTypeId === b.externalRoomTypeId &&
    a.externalRatePlanId === b.externalRatePlanId &&
    a.checkIn === b.checkIn &&
    a.checkOut === b.checkOut &&
    a.adults === b.adults &&
    a.children === b.children,
  );
}
