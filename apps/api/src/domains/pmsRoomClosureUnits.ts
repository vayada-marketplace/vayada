import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";

/** Terminal PMS closure only. Caller holds inventory/facts/units/publication locks.
 * Historical assignments and blocks retain their unit IDs. Ordinary individual
 * unit retirement keeps its stricter protections and does not call this port.
 */
export async function retireClosingRoomUnits(
  client: DistributionBookingPublicationTransaction,
  scope: { propertyId: string; roomTypeId: string; commandId: string },
): Promise<{ retiredUnitIds: string[]; roomUnitsRevision: number }> {
  const values = [scope.propertyId, scope.roomTypeId, scope.commandId];
  const receipt = (
    await client.query<{ revision: number; cutoff: string }>(
      `SELECT closure.expected_room_units_revision::int AS revision,closure.cutoff_date::text AS cutoff
    FROM pms.room_type_closures closure JOIN pms.room_types room
      ON room.property_id=closure.property_id AND room.id=closure.room_type_id
    WHERE closure.property_id=$1::uuid AND closure.room_type_id=$2::uuid AND closure.command_id=$3::uuid
      AND room.active AND room.room_units_revision=closure.expected_room_units_revision
      AND room.room_units_revision<2147483647 FOR UPDATE OF room`,
      values,
    )
  ).rows[0];
  if (!receipt) throw new Error("Unit closure requires its receipt and unchanged units revision");
  const protection = (
    await client.query<{ protected: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pms.rooms WHERE property_id=$1::uuid AND room_type_id=$2::uuid
      AND status NOT IN ('available','retired'))
    OR EXISTS(SELECT 1 FROM pms.operational_booking_assignments
      WHERE property_id=$1::uuid AND room_type_id=$2::uuid
        AND assignment_status NOT IN ('checked_out','canceled','released'))
    OR EXISTS(SELECT 1 FROM pms.room_blocks WHERE property_id=$1::uuid
      AND (room_type_id=$2::uuid OR source_room_type_id=$2::uuid)
      AND status='active' AND ends_on>=$3::date)
    OR EXISTS(SELECT 1 FROM pms.inventory_days WHERE property_id=$1::uuid AND room_type_id=$2::uuid
      AND stay_date>=$3::date AND (closure_source_revision<>1 OR assigned_count<>0 OR blocked_count<>0
        OR available_count<>0 OR status<>'closed')) AS protected`,
      [scope.propertyId, scope.roomTypeId, receipt.cutoff],
    )
  ).rows[0];
  if (!protection || protection.protected) throw new Error("Closing room units remain protected");
  const retired = await client.query<{ id: string }>(
    `UPDATE pms.rooms unit SET status='retired',updated_at=GREATEST(unit.updated_at,closure.accepted_at)
    FROM pms.room_type_closures closure
    WHERE closure.property_id=$1::uuid AND closure.room_type_id=$2::uuid AND closure.command_id=$3::uuid
      AND unit.property_id=closure.property_id AND unit.room_type_id=closure.room_type_id
      AND unit.status='available' RETURNING unit.id::text`,
    values,
  );
  await client.query(
    `UPDATE pms.room_types SET room_units_revision=room_units_revision+1
    WHERE property_id=$1::uuid AND id=$2::uuid`,
    values.slice(0, 2),
  );
  return {
    retiredUnitIds: retired.rows.map((unit) => unit.id).sort(),
    roomUnitsRevision: receipt.revision + 1,
  };
}
