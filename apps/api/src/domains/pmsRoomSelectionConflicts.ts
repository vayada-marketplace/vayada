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

export async function pmsRoomStayRestrictionsAllow(
  transaction: InventoryReservationTransaction,
  input: {
    propertyId: string;
    roomTypeId: string;
    ratePlanId: string | null;
    checkIn: string;
    checkOut: string;
  },
): Promise<boolean> {
  const result = await transaction.query<{ blocked: boolean }>(
    `SELECT NOT pms.stay_restrictions_allow($1::uuid,$2::uuid,$3::uuid,$4::date,$5::date) AS blocked`,
    [input.propertyId, input.roomTypeId, input.ratePlanId, input.checkIn, input.checkOut],
  );
  return result.rows[0]?.blocked === false;
}
