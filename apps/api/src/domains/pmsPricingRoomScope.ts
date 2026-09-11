import type { PoolClient } from "pg";

/** PMS-owned transaction adapter for Booking's offer terms writer. */
export async function lockPmsPricingRoomScope(client: PoolClient, propertyId: string, roomTypeId: string): Promise<boolean> {
  const room = await client.query(`SELECT id FROM pms.room_types
    WHERE property_id=$1 AND id=$2 AND active=true FOR SHARE`, [propertyId, roomTypeId]);
  return room.rowCount === 1;
}

/** PMS capacity check for distribution, after the room-source mutation lock. */
export async function lockPmsPricingRoomCapacity(
  client: PoolClient,
  propertyId: string,
  roomTypeId: string,
  capacity: Readonly<{ total: number; adults: number; children: number }>,
): Promise<boolean> {
  const row = (
    await client.query(
      "SELECT occupancy_limits FROM pms.room_types WHERE property_id=$1 AND id=$2 AND active=true FOR SHARE",
      [propertyId, roomTypeId],
    )
  ).rows[0];
  const limits = row?.occupancy_limits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return false;
  const total = limits.total,
    adults = limits.adults ?? total,
    children = limits.children ?? total;
  return (
    Number.isInteger(total) &&
    total > 0 &&
    Number.isInteger(adults) &&
    adults > 0 &&
    adults <= total &&
    Number.isInteger(children) &&
    children >= 0 &&
    children <= total &&
    capacity.total <= total &&
    capacity.adults <= adults &&
    capacity.children <= children
  );
}
