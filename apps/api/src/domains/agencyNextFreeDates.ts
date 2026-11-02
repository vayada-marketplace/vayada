import {
  calculateReplacementRoomStay,
  pricingOfferOnBookingPage,
  type PricingConfiguration,
} from "@vayada/domain-pms";
import type { Pool } from "pg";
import { cheapestRooms, type AgencySearch } from "./agencyStayPrices.js";
import { oneRoomFits, roomsForParty, splitAdults } from "./publicPricingStayPrices.js";
import {
  readCurrentPricingSnapshot,
  type StoredPricingRevision,
} from "./replacementPricingSnapshot.js";

/** How far after the searched arrival the next free dates are looked for (VAY-2458). */
export const NEXT_FREE_DAYS = 60;

/** Rooms of one type free on one night, by the rule stay prices apply (`freeRooms`). */
export type FreeNight = { roomTypeId: string; stayDate: string; free: number };

const DAY = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * Arrivals after the searched one, at most 60 days later, for the same number of nights, where the
 * stay has rooms for the party (or for each room of it) by the quote's own rules: free rooms every
 * night, and a rate on the booking page that prices the stay. That rate check is the quote's
 * calculation, so minimum and maximum stay, closed to arrival or departure, stop sell and nights
 * without a price all count. In order; callers confirm a window with the stay's own price read,
 * which also knows what this leaves out (rooms out of service, rates guests can't pay).
 */
export function freeWindows(
  pricing: Pick<StoredPricingRevision, "rooms">,
  nights: readonly FreeNight[],
  search: AgencySearch,
): { checkIn: string; checkOut: string }[] {
  const stay = Math.round((Date.parse(search.checkOut) - Date.parse(search.checkIn)) / DAY);
  const free = new Map(nights.map((n) => [`${n.roomTypeId}|${n.stayDate}`, Math.max(n.free, 0)]));
  const windows = [];
  for (let offset = 1; offset <= NEXT_FREE_DAYS; offset++) {
    const checkIn = addDays(search.checkIn, offset),
      checkOut = addDays(checkIn, stay);
    const dates = Array.from({ length: stay }, (_, night) => addDays(checkIn, night));
    const left = pricing.rooms.map((room) =>
      Math.min(...dates.map((date) => free.get(`${room.roomTypeId}|${date}`) ?? 0)),
    );
    // Whether a rate of this room type prices the stay for rooms of these adults.
    const priced = (room: PricingConfiguration, adults: number[]) => {
      const terms = Object.fromEntries(room.offers.map((offer) => [offer.id, offer.termsRevision]));
      return room.offers.filter(pricingOfferOnBookingPage).some((offer) =>
        [...new Set(adults)].every(
          (perRoom) =>
            calculateReplacementRoomStay(room, {
              propertyId: room.propertyId,
              roomTypeId: room.roomTypeId,
              offerId: offer.id,
              expectedRevision: room.revision,
              expectedTermsRevisions: terms,
              checkIn,
              checkOut,
              guests: { adults: perRoom, childAgesAtCheckIn: [] },
            }).kind === "priced",
        ),
      );
    };
    const occupancy = (room: PricingConfiguration) => ({
      maxGuests: room.capacity.total,
      maxAdults: room.capacity.adults,
      maxChildren: room.capacity.children,
    });
    let open: boolean;
    if (!search.rooms) {
      open = pricing.rooms.some((room, index) => {
        const count = roomsForParty(occupancy(room), search.adults, search.children);
        return (
          count !== null && left[index]! >= count && priced(room, splitAdults(search.adults, count))
        );
      });
    } else {
      const kinds = [...new Map(search.rooms.map((r) => [`${r.adults}-${r.children}`, r]))];
      const counts = kinds.map(
        ([key]) => search.rooms!.filter((r) => `${r.adults}-${r.children}` === key).length,
      );
      open =
        cheapestRooms(counts, left, (kind, type) => {
          const room = pricing.rooms[type]!,
            guests = kinds[kind]![1];
          return left[type]! >= 1 &&
            oneRoomFits(occupancy(room), guests) &&
            priced(room, [guests.adults])
            ? 0n
            : null;
        }) !== null;
    }
    if (open) windows.push({ checkIn, checkOut });
  }
  return windows;
}

/**
 * The stay's current saved prices and its free rooms for the 60 days after the searched arrival,
 * read in one read-only snapshot without locks (the display pool), then `freeWindows`.
 */
export async function readFreeWindows(pool: Pool, propertyId: string, search: AgencySearch) {
  const stay = Math.round((Date.parse(search.checkOut) - Date.parse(search.checkIn)) / DAY);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const pricing = await readCurrentPricingSnapshot(client, propertyId);
    if (!pricing) return [];
    const nights = await client.query<FreeNight>(
      `SELECT room_type_id::text AS "roomTypeId", stay_date::text AS "stayDate",
              CASE WHEN status = 'open' AND rate_gate_open IS NOT FALSE
                THEN LEAST(available_count, total_count - assigned_count - blocked_count)
                ELSE 0 END::int AS free
         FROM pms.inventory_days
        WHERE property_id = $1::uuid AND stay_date >= $2::date AND stay_date < $3::date`,
      [propertyId, addDays(search.checkIn, 1), addDays(search.checkIn, 1 + NEXT_FREE_DAYS + stay)],
    );
    return freeWindows(pricing, nights.rows, search);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}
