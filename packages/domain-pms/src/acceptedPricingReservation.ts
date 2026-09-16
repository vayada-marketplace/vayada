import type { PmsInventoryReservationBundle } from "./inventoryReservationBundle.js";

export const PMS_ACCEPTED_PRICING_RESERVATION_VERSION =
  "pms-accepted-pricing-reservation.v1" as const;

export type PmsAcceptedPricingRoom = Readonly<{
  position: number;
  selectionId: string;
  roomTypeId: string;
  offerId: string;
  adults: number;
  childAgesAtCheckIn: readonly number[];
}>;

/** Immutable Booking evidence supplied to the PMS owner. The PMS repository
 * resolves receipt/type ownership itself; receipt array order is not a mapping. */
export type PmsAcceptedPricingReservationCommand = Readonly<{
  contractVersion: typeof PMS_ACCEPTED_PRICING_RESERVATION_VERSION;
  acceptanceId: string;
  pricingQuoteId: string;
  guestBookingId: string;
  propertyId: string;
  organizationId: string;
  acceptedAt: string;
  stay: Readonly<{
    checkIn: string;
    checkOut: string;
  }>;
  inventoryReservation: PmsInventoryReservationBundle;
  rooms: readonly PmsAcceptedPricingRoom[];
}>;

export type PmsAcceptedPricingReservationResult = Readonly<{
  outcome: "adopted" | "replayed";
  guestBookingId: string;
  acceptanceId: string;
}>;

export type PmsAcceptedPricingReservationPort = {
  adoptAcceptedPricingReservation(
    command: PmsAcceptedPricingReservationCommand,
  ): Promise<PmsAcceptedPricingReservationResult>;
};
