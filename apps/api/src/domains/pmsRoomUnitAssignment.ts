import type { QueryResult, QueryResultRow } from "pg";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";

export type PmsRoomUnitAssignmentClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type PmsRoomAvailabilityRow = {
  roomId: string;
  roomTypeId: string;
  status: string;
};

type PendingAssignmentRow = {
  assignmentId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
};

/**
 * VAY-2361: a booking-page booking names a room type, never a unit, so its rooms arrive
 * unassigned. Give each one the first free unit of its type in calendar order, by the same
 * rule as the PMS "Assign" button; a room with no free unit stays unassigned. The caller holds
 * the property's inventory mutation lock and, before writing rows that reference the room types,
 * lockRoomTypesForUnitAssignment (the locks are re-entrant). `options.payload` is merged into each
 * assigned row's assignment_payload (VAY-2368 marks OTA rooms `autoAssigned`).
 */
export async function assignFirstFreeRoomUnits(
  client: PmsRoomUnitAssignmentClient,
  booking: Readonly<{ propertyId: string; guestBookingId: string }>,
  options: Readonly<{ payload?: Readonly<Record<string, unknown>> }> = {},
): Promise<readonly Readonly<{ assignmentId: string; roomId: string }>[]> {
  const pending = (
    await client.query<PendingAssignmentRow>(
      `SELECT id::text AS "assignmentId", room_type_id::text AS "roomTypeId",
              check_in::text AS "checkIn", check_out::text AS "checkOut"
       FROM pms.operational_booking_assignments
       WHERE property_id = $1::uuid AND guest_booking_id = $2::uuid
         AND assignment_status = 'pending' AND room_id IS NULL
         AND check_in IS NOT NULL AND check_out IS NOT NULL
       ORDER BY position
       FOR UPDATE`,
      [booking.propertyId, booking.guestBookingId],
    )
  ).rows;
  if (pending.length === 0) return [];
  const roomTypeIds = await lockRoomTypesForUnitAssignment(
    client,
    booking.propertyId,
    pending.map(({ roomTypeId }) => roomTypeId),
  );
  // The same eligibility as findAvailableRoomForAssignment, in the calendar's room order.
  const rooms = (
    await client.query<{ roomId: string; roomTypeId: string }>(
      `SELECT id::text AS "roomId", room_type_id::text AS "roomTypeId"
       FROM pms.rooms
       WHERE property_id = $1::uuid
         AND room_type_id = ANY($2::uuid[])
         AND status = 'available'
         AND operational_label_status = 'verified'
         AND room_number IS NOT NULL
       ORDER BY sort_order ASC, room_number ASC, id ASC`,
      [booking.propertyId, roomTypeIds],
    )
  ).rows;
  const payload = options.payload ?? {};
  const assigned: { assignmentId: string; roomId: string }[] = [];
  for (const assignment of pending) {
    for (const room of rooms) {
      if (room.roomTypeId !== assignment.roomTypeId) continue;
      const free = await isRoomFreeForAssignmentStay(client, {
        propertyId: booking.propertyId,
        roomId: room.roomId,
        roomTypeId: room.roomTypeId,
        assignmentId: assignment.assignmentId,
        assignmentRoomTypeId: assignment.roomTypeId,
        checkIn: assignment.checkIn,
        checkOut: assignment.checkOut,
      });
      if (!free) continue;
      await client.query(
        `UPDATE pms.operational_booking_assignments
         SET room_id = $1::uuid,
             assignment_status = 'assigned',
             assigned_at = COALESCE(assigned_at, now()),
             assignment_payload = COALESCE(assignment_payload, '{}'::jsonb) || $4::jsonb,
             updated_at = now()
         WHERE id = $2::uuid AND property_id = $3::uuid
           AND assignment_status = 'pending' AND room_id IS NULL`,
        [room.roomId, assignment.assignmentId, booking.propertyId, JSON.stringify(payload)],
      );
      assigned.push({ assignmentId: assignment.assignmentId, roomId: room.roomId });
      break;
    }
  }
  return assigned;
}

export async function findAvailableRoomForAssignment(
  client: PmsRoomUnitAssignmentClient,
  propertyId: string,
  roomId: string,
): Promise<PmsRoomAvailabilityRow | null> {
  const result = await client.query<PmsRoomAvailabilityRow>(
    `SELECT
       id::text AS "roomId",
       room_type_id::text AS "roomTypeId",
       status
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND status = 'available'
       AND operational_label_status = 'verified'
       AND room_number IS NOT NULL
     LIMIT 1`,
    [propertyId, roomId],
  );
  return result.rows[0] ?? null;
}

/** Locks each room type's units in sorted order, as the Assign button and room reorder do. */
export async function lockRoomTypesForUnitAssignment(
  client: PmsRoomUnitAssignmentClient,
  propertyId: string,
  roomTypeIds: readonly string[],
): Promise<string[]> {
  const sorted = [...new Set(roomTypeIds)].sort();
  for (const roomTypeId of sorted) {
    await lockRoomTypeRoomsForAssignment(client, propertyId, roomTypeId);
  }
  return sorted;
}

export async function lockRoomTypeRoomsForAssignment(
  client: PmsRoomUnitAssignmentClient,
  propertyId: string,
  roomTypeId: string,
): Promise<void> {
  await lockPmsPhysicalRoomUnitMutationScope(client, propertyId, roomTypeId);
  await client.query(
    `SELECT id
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
     ORDER BY id
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
}

/** True when `roomId` (of `roomTypeId`) can take this assignment's stay: no other assigned stay or
 * room block on it, its type not sold out, and canonical inventory open on every night. */
export async function isRoomFreeForAssignmentStay(
  client: PmsRoomUnitAssignmentClient,
  stay: Readonly<{
    propertyId: string;
    roomId: string;
    roomTypeId: string;
    assignmentId: string;
    assignmentRoomTypeId: string;
    checkIn: string;
    checkOut: string;
  }>,
): Promise<boolean> {
  const result = await client.query(
    `WITH stay_dates AS (
       SELECT generate_series($4::date, $5::date - interval '1 day', interval '1 day')::date AS stay_date
     ),
     overlapping_assignments AS (
       SELECT 1
       FROM pms.operational_booking_assignments other_assignment
       JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
       WHERE other_assignment.property_id = $1::uuid
         AND other_assignment.room_id = $2::uuid
         AND other_assignment.id <> $3::uuid
         AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
         AND daterange(
               COALESCE(other_assignment.check_in, other_booking.check_in),
               COALESCE(other_assignment.check_out, other_booking.check_out), '[)'
             ) &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_specific_blocks AS (
       SELECT 1
       FROM pms.room_blocks block
       WHERE block.property_id = $1::uuid
         AND block.room_type_id = $6::uuid
         AND block.status = 'active'
         AND block.room_id = $2::uuid
         AND daterange(block.starts_on, block.ends_on + 1, '[)') &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_type_capacity AS (
       SELECT COUNT(*)::integer AS total_count
       FROM pms.rooms room
       WHERE room.property_id = $1::uuid
         AND room.room_type_id = $6::uuid
         AND room.status = 'available'
     ),
     assigned_by_date AS (
       SELECT
         stay_dates.stay_date,
         COUNT(DISTINCT CASE
           WHEN other_booking.id IS NOT NULL THEN other_assignment.room_id
         END)::integer AS assigned_count
       FROM stay_dates
       LEFT JOIN pms.operational_booking_assignments other_assignment
         ON other_assignment.property_id = $1::uuid
        AND other_assignment.room_type_id = $6::uuid
        AND other_assignment.room_id IS NOT NULL
        AND other_assignment.id <> $3::uuid
        AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
       LEFT JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
        AND daterange(
              COALESCE(other_assignment.check_in, other_booking.check_in),
              COALESCE(other_assignment.check_out, other_booking.check_out), '[)'
            ) @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_blocked_by_date AS (
       SELECT
         stay_dates.stay_date,
         COALESCE(SUM(block.blocked_count), 0)::integer AS blocked_count
       FROM stay_dates
       LEFT JOIN pms.room_blocks block
         ON block.property_id = $1::uuid
        AND block.room_type_id = $6::uuid
        AND block.room_id IS NULL
        AND block.status = 'active'
        AND block.source_assignment_id IS DISTINCT FROM $3::uuid
        AND daterange(block.starts_on, block.ends_on + 1, '[)') @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_capacity_sold_out AS (
       SELECT 1
       FROM stay_dates
       CROSS JOIN room_type_capacity
       JOIN assigned_by_date USING (stay_date)
       JOIN type_blocked_by_date USING (stay_date)
       WHERE assigned_by_date.assigned_count + type_blocked_by_date.blocked_count >=
             room_type_capacity.total_count
       LIMIT 1
     ),
     canonical_inventory_unavailable AS (
       SELECT 1
       FROM stay_dates
       JOIN type_blocked_by_date USING (stay_date)
       LEFT JOIN pms.inventory_days inventory
         ON inventory.property_id=$1::uuid AND inventory.room_type_id=$6::uuid
        AND inventory.stay_date=stay_dates.stay_date
       WHERE inventory.calendar_revision IS NULL OR inventory.status<>'open'
          OR GREATEST(inventory.assigned_count
               - CASE WHEN $6::uuid=$7::uuid THEN 1 ELSE 0 END,0)
             + type_blocked_by_date.blocked_count >=
             inventory.effective_sellable_limit_count
          OR (inventory.linked_stop_sell AND EXISTS (
            SELECT 1 FROM pms.room_types target_type
            JOIN pms.room_types source_type ON source_type.property_id=target_type.property_id
              AND source_type.linked_inventory_group_id=target_type.linked_inventory_group_id
            WHERE target_type.property_id=$1::uuid AND target_type.id=$6::uuid
              AND target_type.linked_inventory_group_id IS NOT NULL
              AND (EXISTS (SELECT 1 FROM pms.inventory_reservation_receipts receipt
                JOIN pms.inventory_reservation_statuses receipt_status
                  ON receipt_status.receipt_id=receipt.receipt_id
                WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=source_type.id
                  AND receipt_status.lifecycle_state='reserved'
                  AND stay_dates.stay_date>=receipt.check_in
                  AND stay_dates.stay_date<receipt.check_out)
                OR EXISTS (SELECT 1 FROM pms.operational_booking_assignments cause
                  WHERE cause.property_id=$1::uuid AND cause.room_type_id=source_type.id
                    AND cause.id<>$3::uuid AND cause.stay_evidence_kind='exact'
                    AND cause.assignment_status NOT IN ('canceled','released')
                    AND stay_dates.stay_date>=cause.check_in
                    AND stay_dates.stay_date<cause.check_out)
                OR EXISTS (SELECT 1 FROM pms.room_blocks cause
                  WHERE cause.property_id=$1::uuid AND cause.room_type_id=source_type.id
                    AND cause.block_kind='manual' AND cause.status='active'
                    AND stay_dates.stay_date BETWEEN cause.starts_on AND cause.ends_on))))
       LIMIT 1
     )
     SELECT 1
     WHERE NOT EXISTS (SELECT 1 FROM overlapping_assignments)
       AND NOT EXISTS (SELECT 1 FROM room_specific_blocks)
       AND NOT EXISTS (SELECT 1 FROM type_capacity_sold_out)
       AND NOT EXISTS (SELECT 1 FROM canonical_inventory_unavailable)`,
    [
      stay.propertyId,
      stay.roomId,
      stay.assignmentId,
      stay.checkIn,
      stay.checkOut,
      stay.roomTypeId,
      stay.assignmentRoomTypeId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
