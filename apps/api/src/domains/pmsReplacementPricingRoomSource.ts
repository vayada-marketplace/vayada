import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

/** PMS-owned complete room-facts source, inside a caller-authorized transaction.
 * The property mutation lock covers creation/removal as well as existing rows.
 * This is not physical-unit inventory/availability or retired pricing evidence.
 * Prices depend on which room types exist and their occupancy; names, descriptions, photos,
 * other facts and the active flag can change without saving prices again (VAY-2129).
 * Read-side checks pass the saved prices being checked: rooms created after them and not
 * priced in them are left out, so adding a room does not make saved prices stale. */
export async function lockPmsReplacementPricingRoomSource(client: PoolClient, propertyId: string,
  saved?: Readonly<{ revision: number; roomTypeIds: readonly string[] }>): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) return null;
  propertyId = propertyId.toLowerCase();
  await lockPmsRoomFactsMutationScope(client, propertyId);
  // JSONB text preserves exact numbers and database-normalized key order.
  const rows = (await client.query(`SELECT room.id,room.active,room.room_facts_revision::text AS revision,
    room.occupancy_limits::text AS occupancy_limits,room.room_attributes::text AS room_attributes,
    $2::integer IS NULL OR room.id=ANY($3::uuid[]) OR room.created_at<=saved.created_at AS counted
    FROM pms.room_types room LEFT JOIN pms.pricing_v2_revisions saved
      ON saved.property_id=room.property_id AND saved.revision=$2::integer
    WHERE room.property_id=$1 ORDER BY room.id FOR SHARE OF room`,
  [propertyId, saved?.revision ?? null, saved?.roomTypeIds ?? []])).rows;
  const source = (value: unknown) => "pms.pricing.rooms.v2:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const current = source({ propertyId, priced: "rooms.v3",
    rooms: rows.filter((room) => room.counted).map(({ id, occupancy_limits }) => ({ id, occupancy_limits })) });
  // Prices saved before VAY-2129 fingerprinted every room fact; they stay current until a room changes.
  const stored = (await client.query(`SELECT revision.source_revisions->>'room' AS room
    FROM pms.pricing_v2_heads head JOIN pms.pricing_v2_revisions revision USING(property_id,revision)
    WHERE head.property_id=$1`, [propertyId])).rows[0]?.room;
  const legacy = source({ propertyId,
    rooms: rows.map(({ id, active, revision, occupancy_limits, room_attributes }) => ({ id, active, revision, occupancy_limits, room_attributes })) });
  return stored !== current && stored === legacy ? stored : current;
}
