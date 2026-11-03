import {
  calculateReplacementRoomStay,
  pricingOfferOnBookingPage,
  type PricingConfiguration,
} from "@vayada/domain-pms";
import type { Pool } from "pg";
import { cheapestRooms, type FreeWindow, type StayOffers } from "./agencyStayPrices.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { oneRoomFits } from "./publicPricingStayPrices.js";
import type { StoredPricingRevision } from "./replacementPricingSnapshot.js";

/** How far after the searched arrival the next free dates are looked for (VAY-2458). */
export const NEXT_FREE_DAYS = 60;

/** Rooms of one type free on one night, by the rule stay prices apply (`freeRooms`). */
export type FreeNight = { roomTypeId: string; stayDate: string; free: number };

type Party = { adults: number; children: number };

const DAY = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * The first `limit` arrivals after the searched one, at most 60 days later, for the same number of
 * nights, where the stay has a room for each of the party's rooms (`slots`) by the quote's own
 * rules: free rooms every night, and a rate that prices the stay. That rate check is the quote's
 * calculation, so minimum and maximum stay, closed to arrival or departure, stop sell and nights
 * without a price all count. Only rates `listed` are tried (a rate may still price from another).
 * Each window names the rate that found each room type free; callers confirm it with the stay's
 * own price read of those rates.
 */
export function freeWindows(
  pricing: Pick<StoredPricingRevision, "rooms">,
  nights: readonly FreeNight[],
  dates: { checkIn: string; checkOut: string },
  slots: readonly Party[],
  limit: number,
  listed: (roomTypeId: string, offerId: string) => boolean = () => true,
): { checkIn: string; checkOut: string; offers: { roomTypeId: string; offerId: string }[] }[] {
  const stay = Math.round((Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / DAY);
  const free = new Map(nights.map((n) => [`${n.roomTypeId}|${n.stayDate}`, Math.max(n.free, 0)]));
  const kinds = [...new Map(slots.map((slot) => [`${slot.adults}-${slot.children}`, slot]))];
  const counts = kinds.map(
    ([key]) => slots.filter((slot) => `${slot.adults}-${slot.children}` === key).length,
  );
  const windows = [];
  for (let offset = 1; offset <= NEXT_FREE_DAYS && windows.length < limit; offset++) {
    const checkIn = addDays(dates.checkIn, offset),
      checkOut = addDays(checkIn, stay);
    const days = Array.from({ length: stay }, (_, night) => addDays(checkIn, night));
    const left = pricing.rooms.map((room) =>
      Math.min(...days.map((date) => free.get(`${room.roomTypeId}|${date}`) ?? 0)),
    );
    // The first rate of the room type that prices the stay for a room of these adults.
    const pricedBy = (room: PricingConfiguration, adults: number) => {
      const terms = Object.fromEntries(room.offers.map((offer) => [offer.id, offer.termsRevision]));
      return room.offers
        .filter((offer) => pricingOfferOnBookingPage(offer) && listed(room.roomTypeId, offer.id))
        .find(
          (offer) =>
            calculateReplacementRoomStay(room, {
              propertyId: room.propertyId,
              roomTypeId: room.roomTypeId,
              offerId: offer.id,
              expectedRevision: room.revision,
              expectedTermsRevisions: terms,
              checkIn,
              checkOut,
              guests: { adults, childAgesAtCheckIn: [] },
            }).kind === "priced",
        )?.id;
    };
    const rates = new Map<string, string>();
    const placed = cheapestRooms(counts, left, (kind, type) => {
      const room = pricing.rooms[type]!,
        guests = kinds[kind]![1];
      if (
        left[type]! < 1 ||
        !oneRoomFits(
          {
            maxGuests: room.capacity.total,
            maxAdults: room.capacity.adults,
            maxChildren: room.capacity.children,
          },
          guests,
        )
      )
        return null;
      const offerId = pricedBy(room, guests.adults);
      if (offerId === undefined) return null;
      rates.set(`${kind}|${type}`, offerId);
      return 0n;
    });
    if (!placed) continue;
    const offers = new Map(
      placed.assignment.map(([kind, type]) => {
        const roomTypeId = pricing.rooms[type]!.roomTypeId,
          offerId = rates.get(`${kind}|${type}`)!;
        return [`${roomTypeId}|${offerId}`, { roomTypeId, offerId }];
      }),
    );
    windows.push({ checkIn, checkOut, offers: [...offers.values()] });
  }
  return windows;
}

/**
 * The stay's current prices, cut to the rooms and rates its page offers (`offered`), and its free
 * rooms for the 60 days after the searched arrival, read in one snapshot on the display pool,
 * which takes no locks; then `freeWindows`, each window with the public keys of its rates.
 */
export async function readFreeWindows(
  pool: Pool,
  slug: string,
  dates: { checkIn: string; checkOut: string },
  slots: readonly Party[],
  offered: StayOffers,
  limit: number,
): Promise<FreeWindow[]> {
  const stay = Math.round((Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / DAY);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const owner = await lockPublicPricingPublication(client, slug);
    if (!owner) return [];
    const keys = new Map(
      publicPricingOfferBindings(owner).map((binding) => [
        `${binding.roomTypeId}|${binding.offerId}`,
        binding.publicOfferKey,
      ]),
    );
    const offeredKeys = new Set(
      offered.rooms.flatMap((room) =>
        room.offers.map((offer) => `${room.roomTypeId}|${offer.publicOfferKey}`),
      ),
    );
    const listed = (roomTypeId: string, offerId: string) =>
      offeredKeys.has(`${roomTypeId}|${keys.get(`${roomTypeId}|${offerId}`)}`);
    // Whole rooms, so a rate that prices from another still can.
    const rooms = owner.publication.rooms.filter((room) =>
      room.offers.some((offer) => listed(room.roomTypeId, offer.id)),
    );
    if (!rooms.length) return [];
    const nights = await client.query<FreeNight>(
      `SELECT room_type_id::text AS "roomTypeId", stay_date::text AS "stayDate",
              CASE WHEN status = 'open' AND rate_gate_open IS NOT FALSE
                THEN LEAST(available_count, total_count - assigned_count - blocked_count)
                ELSE 0 END::int AS free
         FROM pms.inventory_days
        WHERE property_id = $1::uuid AND room_type_id = ANY($2::uuid[])
          AND stay_date >= $3::date AND stay_date < $4::date`,
      [
        owner.scope.propertyId,
        rooms.map((room) => room.roomTypeId),
        addDays(dates.checkIn, 1),
        addDays(dates.checkIn, 1 + NEXT_FREE_DAYS + stay),
      ],
    );
    return freeWindows({ rooms }, nights.rows, dates, slots, limit, listed).map((window) => ({
      checkIn: window.checkIn,
      checkOut: window.checkOut,
      offers: window.offers.map(({ roomTypeId, offerId }) => ({
        roomTypeId,
        publicOfferKey: keys.get(`${roomTypeId}|${offerId}`)!,
      })),
    }));
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}
