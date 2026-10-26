import type { Booking } from "@/services/bookings";

type GuestNames = { firstName?: string | null; lastName?: string | null };

/** A guest counts as registered once both names are saved: the PMS stores no date of birth,
 * document or gender yet, so it can't ask for them. */
export function guestRegistered(guest: GuestNames): boolean {
  return Boolean(guest.firstName?.trim() && guest.lastName?.trim());
}

/** Everyone staying, never fewer than the booker. */
export function expectedGuestCount(
  booking: Pick<Booking, "numberOfGuests" | "adults" | "children">,
): number {
  return Math.max(1, booking.numberOfGuests ?? booking.adults + booking.children);
}

/** The booker plus every saved additional guest with both names. */
export function registeredGuestCount(
  booking: Pick<Booking, "guestFirstName" | "guestLastName">,
  additionalGuests: GuestNames[],
): number {
  const booker = guestRegistered({
    firstName: booking.guestFirstName,
    lastName: booking.guestLastName,
  });
  return (booker ? 1 : 0) + additionalGuests.filter(guestRegistered).length;
}
