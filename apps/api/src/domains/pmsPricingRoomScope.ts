import type { PoolClient } from "pg";

/** PMS-owned transaction adapter for Booking's offer terms writer. */
export async function lockPmsPricingRoomScope(client: PoolClient, propertyId: string, roomTypeId: string): Promise<boolean> {
  const room = await client.query(`SELECT id FROM pms.room_types
    WHERE property_id=$1 AND id=$2 AND active=true FOR SHARE`, [propertyId, roomTypeId]);
  return room.rowCount === 1;
}
