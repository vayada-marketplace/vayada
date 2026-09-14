import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";

/** Caller holds property inventory, room/unit, then publication locks in one transaction. */
export async function suppressClosingRoomOffers(
  transaction: DistributionBookingPublicationTransaction,
  scope: { propertyId: string; roomTypeId: string },
): Promise<{ suppressedOfferDays: number }> {
  const room = (await readPmsRoomOperatingEligibility(transaction, scope.propertyId)).find(
    (room) => room.roomTypeId === scope.roomTypeId,
  );
  if (room?.state !== "closing" || !room.closureCommandId) {
    throw new Error("Distribution offer suppression requires a PMS room closure receipt");
  }
  const result = await transaction.query(
    `UPDATE distribution.public_room_offer_snapshots
    SET availability_status='closed',sellable_publicly=false,available_rooms=0,
        unavailable_reasons=ARRAY['unpublished']::text[],updated_at=now()
    WHERE property_id=$1::uuid AND room_type_id=$2::uuid
      AND (availability_status<>'closed' OR sellable_publicly OR available_rooms<>0
        OR unavailable_reasons IS DISTINCT FROM ARRAY['unpublished']::text[])`,
    [scope.propertyId, scope.roomTypeId],
  );
  return { suppressedOfferDays: result.rowCount ?? 0 };
}
