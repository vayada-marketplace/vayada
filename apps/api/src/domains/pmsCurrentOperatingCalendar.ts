import {
  HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY,
  lockHotelCatalogOperatingCalendarPropertyProfileEvidence,
} from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  lockPmsOperatingCalendarWithOwnerEvidence,
  type PmsOperatingCalendarReadClient,
} from "./pmsOperatingCalendarReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";

/**
 * Internal owner evidence, not public authorization or stay availability.
 * Caller owns a READ COMMITTED transaction and retains every lock through acceptance.
 * Acquire this before room-facts/physical-unit locks (inventory then profile first).
 */
export async function lockPmsCurrentOperatingCalendar(
  client: Pick<PmsOperatingCalendarReadClient, "query">,
  propertyId: string,
) {
  await lockPmsInventoryMutationScope(client, propertyId);
  const profile = await lockHotelCatalogOperatingCalendarPropertyProfileEvidence(
    client,
    propertyId,
  );
  const rooms = createPgPmsRoomFactsReadModel({ pool: client });
  return lockPmsOperatingCalendarWithOwnerEvidence(
    client,
    propertyId,
    profile,
    HOTEL_CATALOG_OPERATING_CALENDAR_TIME_ZONE_REGISTRY,
    { roomFacts: rooms, roomCapacity: rooms },
  );
}
