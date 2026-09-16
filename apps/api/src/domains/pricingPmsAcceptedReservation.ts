import {
  PMS_ACCEPTED_PRICING_RESERVATION_VERSION,
  type PmsAcceptedPricingReservationCommand,
} from "@vayada/domain-pms";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";

type AcceptedPricingHistory = NonNullable<ReturnType<typeof decodePricingAcceptanceHistory>>;

/** Project decoded immutable acceptance into the Booking → PMS command. This
 * does not read current prices, expiry, policies, room names, or PMS mappings. */
export function projectAcceptedPricingReservation(
  history: AcceptedPricingHistory,
): PmsAcceptedPricingReservationCommand | null {
  const rooms = history.quote.stay.rooms.map((room, index) => ({
    position: index + 1,
    selectionId: room.selectionId,
    roomTypeId: room.roomTypeId,
    offerId: room.offerId,
    adults: room.guests.adults,
    childAgesAtCheckIn: [...room.guests.childAgesAtCheckIn],
  }));
  const roomTypeCount = new Set(rooms.map((room) => room.roomTypeId)).size;
  if (
    rooms.length < 1 ||
    rooms.length > 99 ||
    history.reservation.receipts.length !== roomTypeCount
  )
    return null;
  return {
    contractVersion: PMS_ACCEPTED_PRICING_RESERVATION_VERSION,
    acceptanceId: history.id,
    pricingQuoteId: history.quote.quoteId,
    guestBookingId: history.bookingId,
    propertyId: history.propertyId,
    organizationId: history.organizationId,
    acceptedAt: history.acceptedAt,
    stay: {
      checkIn: history.quote.stay.checkIn,
      checkOut: history.quote.stay.checkOut,
    },
    inventoryReservation: structuredClone(history.reservation),
    rooms,
  };
}
