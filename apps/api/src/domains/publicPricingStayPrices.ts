import type { Pool, PoolClient } from "pg";
import { PUBLIC_PRICING_SELECTION_VERSION } from "@vayada/domain-booking";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockPublicPricingChargeTotals } from "./publicPricingChargeTotals.js";

type Occupancy = { maxGuests: number; maxAdults: number; maxChildren: number };
type OfferCatalog = {
  read(slug: string): Promise<{
    rooms: {
      roomTypeId: string;
      occupancy: Occupancy;
      offers: { publicOfferKey: string; currency: string }[];
    }[];
  } | null>;
};

export type StayPricesQuery = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  promoCode: string | null;
};

/** A party never needs more rooms of one type than this on the booking page. */
const MAX_ROOMS = 9;
/** Rooms left at or below this are shown to guests ("Only 2 left"), as the old page did. */
const FEW_LEFT = 3;
/** Offers priced per request; a larger catalog shows the rest without a price. */
const MAX_PRICED_OFFERS = 30;

const date = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const count = (value: unknown, min: number) => {
  const parsed = typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : NaN;
  return parsed >= min ? parsed : null;
};

export function parseStayPricesQuery(query: unknown): StayPricesQuery | null {
  if (!query || typeof query !== "object") return null;
  const q = query as Record<string, unknown>;
  const adults = count(q["adults"], 1),
    children = q["children"] === undefined ? 0 : count(q["children"], 0),
    promo = typeof q["promoCode"] === "string" ? q["promoCode"].trim() : "";
  if (
    !date(q["checkIn"]) ||
    !date(q["checkOut"]) ||
    q["checkOut"] <= q["checkIn"] ||
    nights(q["checkIn"], q["checkOut"]) > 366 ||
    adults === null ||
    children === null ||
    adults + children > 99 ||
    promo.length > 200
  )
    return null;
  return {
    checkIn: q["checkIn"],
    checkOut: q["checkOut"],
    adults,
    children,
    promoCode: promo || null,
  };
}

const nights = (checkIn: string, checkOut: string) =>
  (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000;

/** Rooms of one type the party needs, split as the old booking page did: enough rooms for the
 * adults, the children and everyone, each with at least one adult (VAY-2190). Null when it
 * can't fit, including children in a room that takes none. */
export function roomsForParty(occupancy: Occupancy, adults: number, children: number) {
  if (children > 0 && occupancy.maxChildren === 0) return null;
  const rooms = Math.max(
    1,
    Math.ceil(adults / occupancy.maxAdults),
    children > 0 ? Math.ceil(children / occupancy.maxChildren) : 1,
    Math.ceil((adults + children) / occupancy.maxGuests),
  );
  return rooms <= MAX_ROOMS && rooms <= adults ? rooms : null;
}

/** Adults spread evenly; the first rooms take any remainder. */
export function splitAdults(adults: number, rooms: number) {
  return Array.from(
    { length: rooms },
    (_, index) => Math.floor(adults / rooms) + (index < adults % rooms ? 1 : 0),
  );
}

/** Read-only stay prices for the booking page's room cards (VAY-2190): each offer's total for
 * the stay, from the quote's own calculation, and whether each room type is free on every night
 * by the rule booking acceptance applies. No quote is issued and nothing is held.
 *
 * The calculation takes the hotel's pricing locks, as a quote does, so each offer is priced in
 * its own short transaction with lock and statement timeouts, and sold-out rooms aren't priced.
 * `pool` should be small: it bounds how much pricing work guests' page views can run at once.
 *
 * Children are counted for rooms but not priced until /book knows their ages; the response says
 * so (`childrenPriced`). The quote on /book stays the binding price. */
export function createPublicPricingStayPrices(pool: Pool, catalog: OfferCatalog) {
  return {
    async read(slug: string, query: StayPricesQuery) {
      const offered = await catalog.read(slug);
      if (!offered) return null;
      const free = await short(pool, async (client) => {
        const scope = await lockPublicPricingAuthority(client, slug);
        return scope
          ? freeRooms(
              client,
              scope.propertyId,
              offered.rooms.map(({ roomTypeId }) => roomTypeId),
              query,
            )
          : null;
      });
      if (!free) return null;
      let budget = MAX_PRICED_OFFERS;
      const rooms = [];
      for (const room of offered.rooms) {
        const roomCount = roomsForParty(room.occupancy, query.adults, query.children);
        const left = free.get(room.roomTypeId) ?? 0;
        const available = roomCount !== null && left >= roomCount;
        const offers = [];
        for (const offer of room.offers) {
          const price =
            available && roomCount !== null && budget-- > 0
              ? await short(pool, (client) => stayTotal(client, slug, query, offer, roomCount))
              : null;
          offers.push(
            price
              ? { publicOfferKey: offer.publicOfferKey, status: "priced" as const, ...price }
              : { publicOfferKey: offer.publicOfferKey, status: "unavailable" as const },
          );
        }
        rooms.push({
          roomTypeId: room.roomTypeId,
          roomCount,
          availability: available ? ("available" as const) : ("sold_out" as const),
          roomsLeft: available && left <= FEW_LEFT ? left : null,
          offers,
        });
      }
      return {
        version: "public-pricing-stay-prices.v1" as const,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        childrenPriced: query.children === 0,
        rooms,
      };
    },
  };
}

/** One short read transaction that always rolls back, with timeouts so a guest's page view
 * gives up rather than queue behind staff saving prices or a booking. */
async function short<T>(pool: Pool, read: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '3s'");
    return await read(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/** Rooms free on every night: an open, rate-gated inventory day for each night, counting what is
 * available after assigned and blocked rooms (the reserve rule in
 * pmsInventoryReservationLifecycleRepository). */
async function freeRooms(
  client: PoolClient,
  propertyId: string,
  roomTypeIds: string[],
  query: StayPricesQuery,
) {
  const result = await client.query<{ roomTypeId: string; nights: number; free: number }>(
    `SELECT room_type_id::text AS "roomTypeId", COUNT(*)::int AS nights,
            MIN(CASE WHEN status = 'open' AND rate_gate_open IS NOT FALSE
                THEN LEAST(available_count, total_count - assigned_count - blocked_count)
                ELSE 0 END)::int AS free
       FROM pms.inventory_days
      WHERE property_id = $1::uuid AND room_type_id = ANY($2::uuid[])
        AND stay_date >= $3::date AND stay_date < $4::date
      GROUP BY room_type_id`,
    [propertyId, roomTypeIds, query.checkIn, query.checkOut],
  );
  const stay = nights(query.checkIn, query.checkOut);
  return new Map(
    result.rows.map((row) => [row.roomTypeId, row.nights === stay ? Math.max(row.free, 0) : 0]),
  );
}

/** One offer's stay total for the party. A promo code that doesn't apply to this stay makes the
 * calculation refuse, so the price without it is returned and says so. */
async function stayTotal(
  client: PoolClient,
  slug: string,
  query: StayPricesQuery,
  offer: { publicOfferKey: string; currency: string },
  roomCount: number,
) {
  const price = async (promoCode: string | null) =>
    (
      await lockPublicPricingChargeTotals(client, slug, {
        version: PUBLIC_PRICING_SELECTION_VERSION,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        currency: offer.currency,
        rooms: splitAdults(query.adults, roomCount).map((adults, index) => ({
          selectionId: `room-${index + 1}`,
          publicOfferKey: offer.publicOfferKey,
          guests: { adults, childAgesAtCheckIn: [] },
        })),
        addons: [],
        promoCode,
      })
    )?.totalMinor ?? null;
  const withCode = query.promoCode === null ? null : await price(query.promoCode);
  if (withCode !== null)
    return { totalMinor: withCode, currency: offer.currency, promoApplied: true };
  const plain = await price(null);
  return plain === null
    ? null
    : { totalMinor: plain, currency: offer.currency, promoApplied: false };
}
