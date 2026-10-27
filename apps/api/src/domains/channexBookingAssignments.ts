import type { PoolClient } from "pg";
import { resolveStagingCatalogReference } from "./channexStagingCatalogReference.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { enqueueHostInventoryChanges } from "./pmsHostInventoryEffects.js";
import {
  assignFirstFreeRoomUnits,
  findAvailableRoomForAssignment,
  isRoomFreeForAssignmentStay,
  lockRoomTypesForUnitAssignment,
} from "./pmsRoomUnitAssignment.js";

export type ChannexRoomStay = {
  externalRoomTypeId: string;
  externalRatePlanId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};
type Stay = ChannexRoomStay & {
  roomTypeId: string;
  ratePlanId: string | null;
  stagingCatalogReferenceId?: string;
};
type Assignment = Stay & {
  id: string;
  position: number;
  roomId: string | null;
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
    stagingCatalogBindingGeneration?: string;
    bootstrapHash?: string;
  },
) {
  const { propertyId, bookingId } = input;
  const existing = (
    await client.query<Assignment>(
      `SELECT id::text,position,room_type_id::text AS "roomTypeId",rate_plan_id::text AS "ratePlanId",
       room_id::text AS "roomId",check_in::text AS "checkIn",check_out::text AS "checkOut",adults,children,
       assignment_payload->'channexStay' AS "providerStay",
       (source='channel' AND assignment_payload->>'version'=assignment_payload->>'channexRevision'
         AND ((assignment_status='pending' AND room_id IS NULL)
           OR (assignment_status='assigned' AND room_id IS NOT NULL
             AND assignment_payload @> '{"autoAssigned":true}'::jsonb))) AS untouched,
       (source='channel' AND assignment_status IN ('pending','assigned')
         AND COALESCE(assignment_payload->>'operationalStatus','confirmed')='confirmed') AS cancelable
     FROM pms.operational_booking_assignments
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid
       AND NOT (source='channel' AND assignment_status='released'
         AND assignment_payload @> '{"channexAlterationReleased":true}'::jsonb)
       ORDER BY position FOR UPDATE`,
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
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND assignment_status<>'released'`,
      [propertyId, bookingId, input.revisionId],
    );
  } else {
    const stays: Stay[] = [];
    for (const room of input.rooms) {
      let mapped: {
        roomTypeId: string;
        ratePlanId: string | null;
        stagingCatalogReferenceId?: string;
      }[] = (
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
      if (
        (input.bootstrapHash || (mapped.length === 0 && input.repair)) &&
        input.stagingCatalogBindingGeneration
      )
        mapped = await resolveStagingCatalogReference(client, {
          ...input,
          ...room,
          bindingGeneration: input.stagingCatalogBindingGeneration,
        });
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
    // VAY-2361 lock order: unit locks before the rows below key-share their room types.
    await lockRoomTypesForUnitAssignment(client, propertyId, [
      ...existing.map((row) => row.roomTypeId),
      ...stays.map((stay) => stay.roomTypeId),
    ]);
    await client.query(
      "DELETE FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND position>$3 AND assignment_status<>'released'",
      [propertyId, bookingId, stays.length],
    );
    for (const [index, stay] of stays.entries()) {
      // VAY-2368 (D1): an auto-assigned unit of the same room type stays on the row for now;
      // assignChannexRoomUnits drops it below when it no longer fits the altered stay.
      const prior = existing.find((row) => row.position === index + 1);
      const keepUnit = Boolean(
        prior && prior.untouched && prior.roomId && prior.roomTypeId === stay.roomTypeId,
      );
      const payload = {
        contractVersion: "channex-operational-assignment.v1",
        channexStay: input.rooms[index],
        channexRevision: input.revisionId,
        ...(stay.stagingCatalogReferenceId
          ? { stagingCatalogReferenceId: stay.stagingCatalogReferenceId }
          : {}),
        version: input.revisionId,
      };
      await client.query(
        `INSERT INTO pms.operational_booking_assignments(property_id,guest_booking_id,room_type_id,rate_plan_id,
          position,assignment_status,channel,source,assignment_payload,stay_evidence_kind,check_in,check_out,adults,children,external_reservation_id)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'pending',$6,'channel',$7::jsonb,'exact',$8::date,$9::date,$10,$11,$12)
         ON CONFLICT(guest_booking_id,position) DO UPDATE SET room_type_id=EXCLUDED.room_type_id,rate_plan_id=EXCLUDED.rate_plan_id,
          assignment_payload=((pms.operational_booking_assignments.assignment_payload-'channexAlterationReleased')
            -CASE WHEN $13::boolean THEN ARRAY[]::text[] ELSE ARRAY['autoAssigned'] END)||EXCLUDED.assignment_payload,
          assignment_status=CASE WHEN $13::boolean THEN 'assigned' ELSE 'pending' END,
          room_id=CASE WHEN $13::boolean THEN pms.operational_booking_assignments.room_id ELSE NULL END,
          assigned_at=CASE WHEN $13::boolean THEN pms.operational_booking_assignments.assigned_at ELSE NULL END,
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
          keepUnit,
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
  if (!input.canceled) await assignChannexRoomUnits(client, propertyId, bookingId);
  return true;
}

const AUTO_ASSIGNED_PAYLOAD = { autoAssigned: true } as const;

/**
 * VAY-2368: an OTA room names a room type, never a unit. Once the booking or alteration is saved,
 * drop an auto-assigned unit that no longer fits the stay, then give every pending room the first
 * free unit of its type by the Assign button's rule (the VAY-2361 helper). A unit the host chose
 * by hand is never touched here: its version no longer matches the Channex revision, so a stay
 * change on it still conflicts above. Runs in its own savepoint, so a failure only leaves rooms
 * unassigned and never stops the booking from reaching the PMS.
 */
async function assignChannexRoomUnits(client: PoolClient, propertyId: string, bookingId: string) {
  await client.query("SAVEPOINT channex_room_unit_auto_assign");
  try {
    await releaseUnfitAutoAssignedUnits(client, propertyId, bookingId);
    await assignFirstFreeRoomUnits(
      client,
      { propertyId, guestBookingId: bookingId },
      { payload: AUTO_ASSIGNED_PAYLOAD },
    );
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT channex_room_unit_auto_assign");
  }
  await client.query("RELEASE SAVEPOINT channex_room_unit_auto_assign");
}

async function releaseUnfitAutoAssignedUnits(
  client: PoolClient,
  propertyId: string,
  bookingId: string,
) {
  const kept = (
    await client.query<{
      assignmentId: string;
      roomId: string;
      roomTypeId: string;
      checkIn: string;
      checkOut: string;
    }>(
      `SELECT id::text AS "assignmentId",room_id::text AS "roomId",room_type_id::text AS "roomTypeId",
         check_in::text AS "checkIn",check_out::text AS "checkOut"
       FROM pms.operational_booking_assignments
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND source='channel'
         AND assignment_status='assigned' AND room_id IS NOT NULL
         AND assignment_payload @> '{"autoAssigned":true}'::jsonb
         AND assignment_payload->>'version'=assignment_payload->>'channexRevision'
         AND check_in IS NOT NULL AND check_out IS NOT NULL
       ORDER BY position FOR UPDATE`,
      [propertyId, bookingId],
    )
  ).rows;
  if (kept.length === 0) return;
  await lockRoomTypesForUnitAssignment(
    client,
    propertyId,
    kept.map(({ roomTypeId }) => roomTypeId),
  );
  for (const row of kept) {
    const room = await findAvailableRoomForAssignment(client, propertyId, row.roomId);
    const fits =
      room !== null &&
      room.roomTypeId === row.roomTypeId &&
      (await isRoomFreeForAssignmentStay(client, {
        propertyId,
        roomId: row.roomId,
        roomTypeId: row.roomTypeId,
        assignmentId: row.assignmentId,
        assignmentRoomTypeId: row.roomTypeId,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
      }));
    if (fits) continue;
    await client.query(
      `UPDATE pms.operational_booking_assignments
       SET room_id=NULL,assignment_status='pending',assigned_at=NULL,
           assignment_payload=assignment_payload-'autoAssigned',updated_at=now()
       WHERE id=$1::uuid AND property_id=$2::uuid AND assignment_status='assigned'`,
      [row.assignmentId, propertyId],
    );
  }
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
