import {
  PMS_ACCEPTED_PRICING_RESERVATION_VERSION,
  type PmsAcceptedPricingReservationCommand,
} from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";

type AcceptedPricingHistory = NonNullable<ReturnType<typeof decodePricingAcceptanceHistory>>;

export type AcceptedPricingReservationReference = {
  acceptanceId: string;
  guestBookingId: string;
  propertyId: string;
};

/** Booking-owned authoritative read for the PMS worker. */
export async function loadAcceptedPricingReservation(
  client: PoolClient,
  reference: AcceptedPricingReservationReference,
): Promise<PmsAcceptedPricingReservationCommand | null> {
  const row = (
    await client.query(
      `SELECT * FROM booking.pricing_quote_acceptances
       WHERE id=$1::uuid AND guest_booking_id=$2::uuid AND property_id=$3::uuid
       FOR UPDATE`,
      [reference.acceptanceId, reference.guestBookingId, reference.propertyId],
    )
  ).rows[0];
  if (!row) return null;
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const history = decodePricingAcceptanceHistory(
    {
      ...row,
      accepted_at: iso(row.accepted_at),
      finance_terms_captured_at: iso(row.finance_terms_captured_at),
    },
    reference.propertyId,
    row.organization_id,
  );
  return history ? projectAcceptedPricingReservation(history) : null;
}

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
