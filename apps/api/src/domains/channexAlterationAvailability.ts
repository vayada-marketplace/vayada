import { z } from "zod";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  readPmsOccupiedInventory,
  type PmsOccupiedInventoryClient,
} from "./pmsOccupiedInventory.js";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const schema = z.object({
  propertyId: uuid,
  bookingId: uuid,
  changes: z.object({
    requestedCheckIn: z.iso.date(),
    requestedCheckOut: z.iso.date(),
    rooms: z
      .array(z.object({ roomTypeId: uuid }))
      .min(1)
      .max(100),
    channex: z.object({ connectionId: uuid }),
  }),
});
/** Runs inside the coordinator transaction. Rejects unsupported linked inventory. */
export async function assertChannexAlterationAvailability(
  client: PmsOccupiedInventoryClient,
  value: { propertyId: string; bookingId: string; changes: Record<string, unknown> },
): Promise<void> {
  const { propertyId, bookingId, changes } = schema.parse(value);
  const from = changes.requestedCheckIn,
    to = changes.requestedCheckOut;
  const nights = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 366)
    throw new Error("alteration_invalid_stay");
  await lockPmsInventoryMutationScope(client, propertyId);
  const externalIds = [...new Set(changes.rooms.map((room) => room.roomTypeId))];
  const mappings = await client.query<{ externalId: string; roomTypeId: string; linked: boolean }>(
    `SELECT mapping.external_room_type_id AS "externalId", room.id::text AS "roomTypeId",
      room.linked_inventory_group_id IS NOT NULL AS linked
     FROM pms.channel_room_type_mappings mapping JOIN pms.room_types room
       ON room.id=mapping.room_type_id AND room.property_id=mapping.property_id
     WHERE mapping.property_id=$1::uuid AND mapping.connection_id=$2::uuid
       AND mapping.status='active' AND room.active AND mapping.external_room_type_id=ANY($3::text[])
     FOR SHARE OF mapping,room`,
    [propertyId, changes.channex.connectionId, externalIds],
  );
  if (mappings.rows.length !== externalIds.length)
    throw new Error("alteration_room_mapping_unavailable");
  if (mappings.rows.some((row) => row.linked))
    throw new Error("alteration_linked_inventory_unsupported");
  const demand = new Map<string, number>();
  for (const room of changes.rooms) {
    const mapped = mappings.rows.find((row) => row.externalId === room.roomTypeId);
    if (!mapped) throw new Error("alteration_room_mapping_unavailable");
    demand.set(mapped.roomTypeId, (demand.get(mapped.roomTypeId) ?? 0) + 1);
  }
  const booking = (
    await client.query<{ checkIn: string; checkOut: string; roomCount: number }>(
      `SELECT check_in::text AS "checkIn",check_out::text AS "checkOut",room_count AS "roomCount"
     FROM booking.guest_bookings WHERE id=$1::uuid AND property_id=$2::uuid
       AND lifecycle_status='confirmed' AND booking_channel='airbnb' FOR UPDATE`,
      [bookingId, propertyId],
    )
  ).rows[0];
  if (!booking) throw new Error("alteration_booking_unavailable");
  const assignments = await client.query<{
    roomTypeId: string;
    checkIn: string;
    checkOut: string;
    source: string;
    evidence: string;
    linked: boolean;
  }>(
    `SELECT assignment.room_type_id::text AS "roomTypeId",
       COALESCE(assignment.check_in,booking.check_in)::text AS "checkIn",
       COALESCE(assignment.check_out,booking.check_out)::text AS "checkOut",assignment.source, assignment.stay_evidence_kind AS evidence,
       room.linked_inventory_group_id IS NOT NULL AS linked
     FROM pms.operational_booking_assignments assignment JOIN booking.guest_bookings booking
       ON booking.id=assignment.guest_booking_id AND booking.property_id=assignment.property_id
     JOIN pms.room_types room ON room.id=assignment.room_type_id AND room.property_id=assignment.property_id
     WHERE assignment.property_id=$1::uuid AND assignment.guest_booking_id=$2::uuid
       AND assignment.assignment_status NOT IN ('canceled','released') FOR SHARE OF assignment,room`,
    [propertyId, bookingId],
  );
  if (
    !booking.roomCount ||
    assignments.rows.length !== booking.roomCount ||
    assignments.rows.some(
      (row) =>
        row.source !== "channel" ||
        row.evidence !== "exact" ||
        row.checkIn !== booking.checkIn ||
        row.checkOut !== booking.checkOut,
    )
  )
    throw new Error("alteration_assignment_evidence_incomplete");
  if (assignments.rows.some((row) => row.linked))
    throw new Error("alteration_linked_inventory_unsupported");
  const roomIds = [...demand.keys()];
  const coverage = await client.query(
    `SELECT day.room_type_id,day.stay_date FROM pms.inventory_days day
     JOIN pms.inventory_materialization_coverage coverage ON coverage.property_id=day.property_id
       AND coverage.calendar_revision=day.calendar_revision
     JOIN pms.operating_calendar_room_bindings binding ON binding.property_id=day.property_id
       AND binding.calendar_revision=day.calendar_revision AND binding.room_type_id=day.room_type_id
     JOIN pms.room_types room ON room.id=day.room_type_id AND room.property_id=day.property_id
     WHERE day.property_id=$1::uuid AND day.room_type_id=ANY($2::uuid[])
       AND day.stay_date >= $3::date AND day.stay_date < $4::date
       AND coverage.coverage_from <= $3::date AND coverage.coverage_through >= $4::date-1
       AND day.calendar_revision=(SELECT MAX(calendar_revision) FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid)
       AND day.inventory_revision IS NOT NULL AND day.generated_source_revision=day.calendar_revision
       AND binding.source_room_facts_revision=room.room_facts_revision
       AND binding.source_room_units_revision=room.room_units_revision
       AND binding.physical_capacity_count=day.total_count
       AND binding.physical_capacity_count=(SELECT COUNT(*) FROM pms.rooms unit
         WHERE unit.property_id=day.property_id AND unit.room_type_id=day.room_type_id AND unit.status<>'retired')
       AND day.blocked_count=LEAST(day.total_count,COALESCE((SELECT SUM(block.blocked_count)
         FROM pms.room_blocks block WHERE block.property_id=day.property_id AND block.room_type_id=day.room_type_id
           AND block.status='active' AND day.stay_date BETWEEN block.starts_on AND block.ends_on),0))
       AND COALESCE(day.rate_gate_open,FALSE) AND day.status<>'closed'
     FOR SHARE OF day,coverage,binding`,
    [propertyId, roomIds, from, to],
  );
  if (coverage.rows.length !== roomIds.length * nights)
    throw new Error("alteration_inventory_not_current");
  const days = await readPmsOccupiedInventory(
    client,
    propertyId,
    roomIds.map((roomTypeId) => ({ roomTypeId, checkIn: from, checkOut: to })),
  );
  for (const day of days) {
    const own = assignments.rows.filter(
      (row) =>
        row.roomTypeId === day.roomTypeId &&
        row.checkIn <= day.stayDate &&
        row.checkOut > day.stayDate,
    ).length;
    const counts = [
      day.totalCount,
      day.effectiveSellableLimitCount,
      day.assignedCount,
      day.expectedAssignedCount,
      day.blockedCount,
    ].map((value) =>
      typeof value === "number" || (typeof value === "string" && value.trim() !== "")
        ? Number(value)
        : NaN,
    );
    if (
      counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      counts[2] !== counts[3] ||
      counts[2]! < own
    )
      throw new Error("alteration_inventory_not_current");
    const [total, effective, assigned, , blocked] = counts;
    if (
      day.status === "closed" ||
      day.linkedStopSell ||
      Math.min(total!, effective!) - (assigned! - own) - blocked! < demand.get(day.roomTypeId)!
    )
      throw new Error("alteration_rooms_unavailable");
  }
}
