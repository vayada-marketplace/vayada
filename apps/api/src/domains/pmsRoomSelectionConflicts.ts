import type { InventoryReservationTransaction } from "../platform/inventoryReservation.js";

/** PMS owns whether otherwise distinct room types sell the same physical space. */
export async function readPmsRoomSelectionConflicts(
  transaction: InventoryReservationTransaction,
  propertyId: string,
  roomTypeIds: readonly string[],
): Promise<Map<string, string | null>> {
  const result = await transaction.query<{ roomTypeId: string; groupId: string | null }>(
    `SELECT id::text AS "roomTypeId",linked_inventory_group_id::text AS "groupId"
     FROM pms.room_types WHERE property_id=$1::uuid AND id=ANY($2::uuid[])`,
    [propertyId, roomTypeIds],
  );
  return new Map(result.rows.map((row) => [row.roomTypeId, row.groupId]));
}

export async function pmsRoomStayRestrictionReason(
  transaction: InventoryReservationTransaction,
  input: {
    propertyId: string;
    roomTypeId: string;
    ratePlanId: string | null;
    checkIn: string;
    checkOut: string;
  },
): Promise<
  "stay_restricted" | "min_stay_not_met" | "max_stay_exceeded" | "unavailable_data" | null
> {
  const result = await transaction.query<{ closed: boolean; minimum: boolean; maximum: boolean }>(
    `SELECT
       COALESCE(bool_or((day::date=$4::date AND rule.closed_to_arrival)
         OR (day::date=$5::date AND rule.closed_to_departure)
         OR (day::date<$5::date AND rule.stop_sell)),false) AS closed,
       COALESCE(bool_or(day::date=$4::date AND rule.min_stay_arrival>($5::date-$4::date)),false) AS minimum,
       COALESCE(bool_or(day::date=$4::date AND rule.max_stay>0 AND rule.max_stay<($5::date-$4::date)),false) AS maximum
     FROM generate_series($4::date,$5::date,interval '1 day') day
     CROSS JOIN LATERAL pms.effective_stay_restrictions($1::uuid,$2::uuid,$3::uuid,day::date) rule`,
    [input.propertyId, input.roomTypeId, input.ratePlanId, input.checkIn, input.checkOut],
  );
  const row = result.rows[0];
  if (!row) return "unavailable_data";
  return row.closed
    ? "stay_restricted"
    : row.minimum
      ? "min_stay_not_met"
      : row.maximum
        ? "max_stay_exceeded"
        : null;
}
