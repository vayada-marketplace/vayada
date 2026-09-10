import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

/** PMS-owned complete room-facts source, inside a caller-authorized transaction.
 * The property mutation lock covers creation/removal as well as existing rows.
 * This is not physical-unit inventory/availability or retired pricing evidence. */
export async function lockPmsReplacementPricingRoomSource(client: PoolClient, propertyId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) return null;
  propertyId = propertyId.toLowerCase();
  await lockPmsRoomFactsMutationScope(client, propertyId);
  // JSONB text preserves exact numbers and database-normalized key order.
  const rooms = (await client.query(`SELECT id,active,room_facts_revision::text AS revision,
    occupancy_limits::text AS occupancy_limits,room_attributes::text AS room_attributes
    FROM pms.room_types WHERE property_id=$1 ORDER BY id FOR SHARE`, [propertyId])).rows;
  return "pms.pricing.rooms.v2:" + createHash("sha256").update(JSON.stringify({ propertyId, rooms })).digest("hex");
}
