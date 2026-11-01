import type { BookingAddon } from "@/services/bookings";

/** What staff pick for an extra in New Booking: a transfer's trips, or how many of anything else. */
export type AddonChoice = { quantity: number; pickup: boolean; dropOff: boolean };
type Stay = { checkIn: string; checkOut: string; adults: number; children: number };
type ServiceUnit = { serviceDate: string | null; guestCount: number | null };
/** An extra as the preview and create requests send it. */
export type AddonLine = { addonId: string; packageCount: number; serviceUnits: ServiceUnit[] };

/** A transfer is booked by trip: pickup on the first arrival day, drop-off on the last departure. */
export const isTransfer = (addon: BookingAddon) =>
  addon.category === "transport" && !addon.perNight;

/** The most staff can pick of a per-stay or per-night extra: its own limit, 1 when unset. */
export function addonMaxQuantity(addon: BookingAddon): number {
  return Number.isInteger(addon.maxQuantity) && addon.maxQuantity! > 0 ? addon.maxQuantity! : 1;
}

function nightsOf(stay: Stay): string[] {
  const nights: string[] = [];
  const date = new Date(`${stay.checkIn}T00:00:00Z`);
  for (let night = stay.checkIn; night && night < stay.checkOut; ) {
    nights.push(night);
    date.setUTCDate(date.getUTCDate() + 1);
    night = date.toISOString().slice(0, 10);
  }
  return nights;
}

/** The party the quantities follow, as the server counts it (VAY-2417). */
export function partyOf(stays: Stay[]) {
  const guests = (stay: Stay) => stay.adults + stay.children;
  const nights = Array.from(new Set(stays.flatMap(nightsOf))).sort();
  const occupancy = (night: string) =>
    stays
      .filter((stay) => stay.checkIn <= night && night < stay.checkOut)
      .reduce((sum, stay) => sum + guests(stay), 0);
  // Guests starting or ending their stay that day; a transfer carries only them.
  const travelling = (date: string) =>
    stays
      .filter((stay) => stay.checkIn === date || stay.checkOut === date)
      .reduce((sum, stay) => sum + guests(stay), 0);
  const checkIns = stays
    .map((stay) => stay.checkIn)
    .filter(Boolean)
    .sort();
  const checkOuts = stays
    .map((stay) => stay.checkOut)
    .filter(Boolean)
    .sort();
  return {
    nights,
    occupancy,
    travelling,
    // Everyone staying at once, so a room move doesn't count its guests twice.
    size: Math.max(0, ...nights.map(occupancy)),
    arrival: nights.length ? checkIns[0]! : null,
    departure: nights.length ? checkOuts[checkOuts.length - 1]! : null,
  };
}

/** The extra's request line, or null while nothing is picked. Every
 * amount follows the party, so staff can't book more than it needs: one per guest, a transfer's
 * vehicles from its group size, anything else up to its own limit. */
export function addonSelection(
  addon: BookingAddon,
  choice: AddonChoice | undefined,
  stays: Stay[],
): AddonLine | null {
  if (!choice) return null;
  const party = partyOf(stays);
  const quantity = Math.min(Math.max(1, choice.quantity), addonMaxQuantity(addon));
  const line = (packageCount: number, serviceUnits: ServiceUnit[]) => ({
    addonId: addon.id,
    packageCount,
    serviceUnits,
  });
  if (isTransfer(addon)) {
    const trips = [choice.pickup && party.arrival, choice.dropOff && party.departure].filter(
      (date): date is string => Boolean(date),
    );
    if (!trips.length) return null;
    if (addon.perPerson)
      return line(
        1,
        trips.map((serviceDate) => ({ serviceDate, guestCount: party.travelling(serviceDate) })),
      );
    const busiest = Math.max(...trips.map(party.travelling));
    const vehicles = addon.maxGuests ? Math.max(1, Math.ceil(busiest / addon.maxGuests)) : 1;
    return line(
      vehicles,
      trips.map((serviceDate) => ({ serviceDate, guestCount: null })),
    );
  }
  if (addon.perNight)
    return line(
      addon.perPerson ? 1 : quantity,
      party.nights.map((serviceDate) => ({
        serviceDate,
        guestCount: addon.perPerson ? party.occupancy(serviceDate) : null,
      })),
    );
  return line(addon.perPerson ? 1 : quantity, [
    { serviceDate: null, guestCount: addon.perPerson ? party.size : null },
  ]);
}
