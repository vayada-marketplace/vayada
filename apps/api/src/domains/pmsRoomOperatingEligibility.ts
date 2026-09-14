import type { PmsRoomOperatingEligibility } from "@vayada/domain-pms";
import type { PmsOperatingCalendarCommandClient } from "./pmsOperatingCalendarCommandRepository.js";

/** Uses the caller's transaction; authorization and coordination locks belong to it. */
export async function readPmsRoomOperatingEligibility(
  client: Pick<PmsOperatingCalendarCommandClient, "query">,
  propertyId: string,
): Promise<readonly PmsRoomOperatingEligibility[]> {
  const result = await client.query<PmsRoomOperatingEligibility>(
    `SELECT room.property_id::text AS "propertyId", room.id::text AS "roomTypeId",
       CASE WHEN NOT room.active THEN 'inactive'
            WHEN closure.room_type_id IS NOT NULL THEN 'closing'
            ELSE 'operating' END AS state,
       closure.command_id::text AS "closureCommandId",
       closure.cutoff_date::text AS "cutoffDate"
     FROM pms.room_types room
     LEFT JOIN pms.room_type_closures closure
       ON closure.property_id=room.property_id AND closure.room_type_id=room.id
     WHERE room.property_id=$1::uuid
     ORDER BY room.id`,
    [propertyId],
  );
  return result.rows;
}
