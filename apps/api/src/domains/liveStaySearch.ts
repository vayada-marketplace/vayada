import { freeCancellationUntil } from "@vayada/domain-booking/replacement-pricing";
import type { Pool, PoolClient } from "pg";
import { readFreeWindows } from "./agencyNextFreeDates.js";
import {
  cheapestRooms,
  narrow,
  NEXT_FREE_TRIES,
  paymentGroups,
  splitParty,
  stayToday,
  type FreeWindow,
} from "./agencyStayPrices.js";
import type { PricingPaymentSwitches } from "./pricingRatePayability.js";
import { createPublicPricingDisplayPool } from "./publicPricingDisplayPool.js";
import { createPublicPricingOfferCatalog } from "./publicPricingOfferCatalog.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";
import { roomRefusal, type Refusal } from "./publicPricingRefusals.js";
import {
  createPublicPricingStayPrices,
  fewestRooms,
  oneRoomFits,
  type StayPricesQuery,
} from "./publicPricingStayPrices.js";

/**
 * VAY-2533: "is it free, and how much?" for one property, from its live availability and prices,
 * as its booking page answers it. A plain in-process service for any caller (Concierge, the AI
 * assistant and MCP), not a public route: it shares neither the per-IP limits nor the stay prices'
 * pool with guests' page views. It reads on a display pool (`createPgLiveStaySearch`), which is
 * read-only and takes no locks, so a search never writes, never holds a price and never makes a
 * hotel's own quotes or bookings wait. The quote on /book stays the binding price.
 */

/** One search: a property, a stay, and who stays. */
export type LiveStaySearch = {
  propertyId: string;
  /** Exact dates; or a number of nights in a month (`YYYY-MM`): the first arrival in that month,
   * from the hotel's today, the party can book. */
  stay: { checkIn: string; checkOut: string } | { month: string; nights: number };
  adults: number;
  /** One entry per child: their age at check-in, or null while unknown. Children are always
   * counted for rooms; they are priced only when every age is known, as on /book. */
  childAges: readonly (number | null)[];
  /** Only this room type. */
  roomTypeId?: string | null;
  /** The most the guests want to pay for the whole stay, in minor units of the hotel's currency:
   * each price says whether it is within it. */
  budgetMinor?: string | null;
};

/** One way to book a room: a rate the booking page offers, priced for the stay. */
export type LiveStayRate = {
  publicOfferKey: string;
  mealPlan: string;
  cancellation: { kind: string; days?: number } | null;
  /** The last day (on the hotel's calendar) the stay can be cancelled for free; null when it
   * can't be, or that day has passed. */
  freeCancellationUntil: string | null;
  paymentMethods: string[];
  /** The stay's total as the booking page quotes it; null when this search didn't price the rate
   * (more rates than one read prices, as on the booking page); it is still bookable. */
  totalMinor: string | null;
  /** The total per night, rounded half up; null with the total. */
  nightlyMinor: string | null;
  currency: string;
  /** Null without a budget or a total. */
  withinBudget: boolean | null;
};

/** One room type for the whole party in one room. */
export type LiveStayRoom = {
  roomTypeId: string;
  name: string;
  occupancy: { maxGuests: number; maxAdults: number; maxChildren: number };
  /** "available": the party can book it; otherwise why not: it takes fewer guests ("too_small"),
   * no room of it is free every night ("sold_out"), the stay is shorter than its rates' minimum
   * from that arrival ("minimum_stay", see `minNights`), or another of the hotel's rules for these
   * dates ("closed": closed to arrival or departure, stop sell, a maximum stay, a night without a
   * price, or too late to book). */
  status: "available" | "too_small" | "sold_out" | "minimum_stay" | "closed";
  /** With "minimum_stay": the minimum stay its rates ask of an arrival that day. */
  minNights: number | null;
  /** Free rooms of this type, only when 3 or fewer (as the booking page shows "Only 2 left"). */
  roomsLeft: number | null;
  /** The rates that can book the stay, in the booking page's order; none unless available. */
  rates: LiveStayRate[];
};

/** The party over more than one room: the cheapest set the booking page books together, priced
 * once as one booking, as its quote prices it (a fixed charge per booking or per night counts
 * once). Each room's rate has no price of its own (`totalMinor` null): the price is the set's. */
export type LiveStaySplit = {
  roomCount: number;
  totalMinor: string;
  nightlyMinor: string;
  currency: string;
  withinBudget: boolean | null;
  rooms: {
    roomTypeId: string;
    name: string;
    adults: number;
    childAges: (number | null)[];
    rate: LiveStayRate;
  }[];
};

export type LiveStaySearchResult = {
  version: "live-stay-search.v1";
  propertyId: string;
  /** "available": a room takes the party, or `split` does; "unavailable": the hotel has rooms for
   * the party, not on these dates; "no_fit": its rooms can't take the party (nor up to 9 of them),
   * or it takes no children; "not_bookable": no live booking page or prices, or not the named
   * room; "past": the arrival is before the hotel's today (or the month is over). */
  status: "available" | "unavailable" | "no_fit" | "not_bookable" | "past";
  /** The stay everything here is for: the asked one, or the month's first bookable arrival. */
  checkIn: string;
  checkOut: string;
  nights: number;
  month: string | null;
  adults: number;
  childAges: (number | null)[];
  /** Whether the prices include the children (every age known). */
  childrenPriced: boolean;
  /** False when the hotel's booking page takes no children (true when not known). */
  childrenAccepted: boolean;
  rooms: LiveStayRoom[];
  /** When no one room is bookable for the whole party: the fewest free rooms (2 to 9) it can
   * book together. */
  split: LiveStaySplit | null;
  /** When nothing is bookable: the first later arrival, within 60 days, for the same number of
   * nights, that is. */
  nearestFree: { checkIn: string; checkOut: string } | null;
};

/** A property's rooms and rates as its booking page offers them
 * (`createPublicPricingOfferCatalog`). */
export type SearchOffers = {
  rooms: {
    roomTypeId: string;
    name: string;
    occupancy: { maxGuests: number; maxAdults: number; maxChildren: number };
    offers: {
      publicOfferKey: string;
      currency: string;
      mealPlan: string;
      cancellation?: { kind: string; days?: number } | null;
      paymentMethods?: readonly string[] | null;
      paymentSchedule?: { kind: string; key?: string } | null;
    }[];
  }[];
};

type StayPricesRead = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createPublicPricingStayPrices>["readOffered"]>>
>;
type Dates = { checkIn: string; checkOut: string };
type Guests = { adults: number; childAges: readonly (number | null)[] };

// VAY-2613: shared with the booking page's stay prices.
export { roomRefusal, type Refusal };

/** Where a search reads from; `createPgLiveStaySearch` wires the real reads. */
export type LiveStaySearchSources = {
  /** The property's booking page address and calendar; null without one. */
  property(propertyId: string): Promise<{
    slug: string;
    timezone: string | null;
    childrenAccepted: boolean;
  } | null>;
  offers(slug: string): Promise<SearchOffers | null>;
  /** The booking page's room prices (`readOffered`); past the search's `budget`, rates are
   * "unpriced". */
  stayPrices(
    slug: string,
    query: StayPricesQuery,
    offered: SearchOffers,
    budget: { left: number },
  ): Promise<StayPricesRead | null>;
  /** One booking of these rooms, each with its own rate and guests, priced as the quote prices it
   * (`readSelection`); null when it can't be. */
  selectionTotal(
    slug: string,
    dates: Dates,
    currency: string,
    rooms: { publicOfferKey: string; adults: number; childAges: readonly number[] }[],
  ): Promise<{ totalMinor: string } | null>;
  /** Later arrivals that may take the party's rooms (`readFreeWindows`), at most a few. */
  freeWindows(
    slug: string,
    dates: Dates,
    slots: { adults: number; children: number }[],
    offered: SearchOffers,
  ): Promise<FreeWindow[]>;
  /** Why these free rooms' rates refuse the stay, by room type. */
  refusals(
    slug: string,
    dates: Dates,
    guests: { adults: number; childAges: readonly number[] },
    rooms: SearchOffers["rooms"],
  ): Promise<ReadonlyMap<string, Refusal>>;
  /** Where a failed side read (reasons, next free dates) is noted; the search answers without it. */
  log?: { warn(fields: object, message: string): void };
  now?: () => number;
};

/** Longer stays are asked for on the booking page itself (as on agency pages). */
const MAX_NIGHTS = 30;
/** A party never books more rooms than this on the booking page. */
const MAX_ROOMS = 9;
/** Rates priced per search (and again for a month's later arrival); past it they are "unpriced",
 * as on agency pages, so one search can't run unbounded pricing work. */
const SEARCH_BUDGET = 300;
/** Dates after this are refused (they would overflow the date arithmetic). */
const LAST_DATE = "2099-12-31";
const MAX_GUESTS = 99;
const MAX_CHILD_AGE = 17;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

const isDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const nightsOf = (dates: Dates) =>
  Math.round((Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / DAY);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const allKnown = (ages: readonly (number | null)[]): ages is readonly number[] =>
  ages.every((age) => age !== null);

/** The search, checked; null when anything is out of range. Dates are YYYY-MM-DD, at most 30
 * nights; at most 99 guests, at least one adult; children 0 to 17 (or null: unknown). */
export function parseLiveStaySearch(input: unknown): LiveStaySearch | null {
  if (!input || typeof input !== "object") return null;
  const {
    propertyId,
    stay,
    adults,
    childAges = [],
    roomTypeId = null,
    budgetMinor = null,
  } = input as Record<string, unknown>;
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) return null;
  if (!isInt(adults, 1, MAX_GUESTS) || !Array.isArray(childAges)) return null;
  if (adults + childAges.length > MAX_GUESTS) return null;
  if (!childAges.every((age) => age === null || isInt(age, 0, MAX_CHILD_AGE))) return null;
  if (roomTypeId !== null && (typeof roomTypeId !== "string" || !UUID.test(roomTypeId)))
    return null;
  if (budgetMinor !== null && (typeof budgetMinor !== "string" || !/^\d{1,18}$/.test(budgetMinor)))
    return null;
  if (!stay || typeof stay !== "object") return null;
  const asked = stay as Record<string, unknown>;
  let dates: LiveStaySearch["stay"];
  if (asked["month"] !== undefined) {
    const { month, nights } = asked;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
    if (month > LAST_DATE.slice(0, 7) || !isInt(nights, 1, MAX_NIGHTS)) return null;
    dates = { month, nights };
  } else {
    const { checkIn, checkOut } = asked;
    if (!isDate(checkIn) || !isDate(checkOut) || checkOut <= checkIn) return null;
    if (checkOut > LAST_DATE || nightsOf({ checkIn, checkOut }) > MAX_NIGHTS) return null;
    dates = { checkIn, checkOut };
  }
  return {
    propertyId,
    stay: dates,
    adults,
    childAges: [...(childAges as (number | null)[])],
    roomTypeId: roomTypeId as string | null,
    budgetMinor: budgetMinor as string | null,
  };
}

/** The last day of a month (`YYYY-MM`). */
const monthEnd = (month: string) => {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, index!, 0)).toISOString().slice(0, 10);
};

/** A room's children ages to price: all of them while the party's are all known, else none
 * (children then go unpriced in every room alike). */
const agesToPrice = (search: LiveStaySearch, room: Guests): readonly number[] | null =>
  allKnown(search.childAges) && allKnown(room.childAges) ? room.childAges : null;

/** The booking page's room prices for the party, one room for `room`'s guests. */
const queryFor = (dates: Dates, search: LiveStaySearch, room: Guests): StayPricesQuery => {
  const ages = agesToPrice(search, room);
  return {
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults: search.adults,
    children: search.childAges.length,
    promoCode: null,
    room: {
      adults: room.adults,
      children: room.childAges.length,
      ...(ages && { childAges: ages }),
    },
  };
};

/** The party in `count` rooms as the booking page spreads it (`splitParty`), children in the
 * order given. */
const splitGuests = (search: LiveStaySearch, count: number): Guests[] => {
  let next = 0;
  return splitParty(search.adults, search.childAges.length, count).map((slot) => ({
    adults: slot.adults,
    childAges: search.childAges.slice(next, (next += slot.children)),
  }));
};

/** Whether each room of the party spread over `count` rooms fits one of `rooms`. */
const placeable = (search: LiveStaySearch, count: number, rooms: SearchOffers["rooms"]) =>
  splitGuests(search, count).every((slot) =>
    rooms.some((room) =>
      oneRoomFits(room.occupancy, { adults: slot.adults, children: slot.childAges.length }),
    ),
  );

/** The fewest rooms, two or more, the party spreads over with one of `rooms` for each; null when
 * no count up to the most a party books does. */
const roomCountFor = (search: LiveStaySearch, rooms: SearchOffers["rooms"]) => {
  const party = { adults: search.adults, children: search.childAges.length };
  const fewest = fewestRooms(rooms, party);
  if (fewest === null) return null;
  for (let count = Math.max(2, fewest); count <= Math.min(search.adults, MAX_ROOMS); count++)
    if (placeable(search, count, rooms)) return count;
  return null;
};

/** Search one property's live prices (see the module comment). */
export function createLiveStaySearch(sources: LiveStaySearchSources) {
  const now = sources.now ?? Date.now;
  type Context = {
    search: LiveStaySearch;
    slug: string;
    offered: SearchOffers;
    today: string;
    month: string | null;
    childrenAccepted: boolean;
    budget: { left: number };
  };

  const answer = (
    search: LiveStaySearch,
    dates: Dates,
    month: string | null,
    status: LiveStaySearchResult["status"],
    childrenAccepted = true,
  ): LiveStaySearchResult => ({
    version: "live-stay-search.v1",
    propertyId: search.propertyId,
    status,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    nights: nightsOf(dates),
    month,
    adults: search.adults,
    childAges: [...search.childAges],
    childrenPriced: allKnown(search.childAges),
    childrenAccepted,
    rooms: [],
    split: null,
    nearestFree: null,
  });

  const rateFor = (
    c: Context,
    dates: Dates,
    offer: SearchOffers["rooms"][number]["offers"][number],
    totalMinor: string | null,
  ): LiveStayRate => {
    const nights = BigInt(nightsOf(dates));
    const cancellation = offer.cancellation ?? null;
    const until =
      cancellation?.kind === "free_until_days_before_arrival" && Number.isInteger(cancellation.days)
        ? freeCancellationUntil(dates.checkIn, cancellation.days!)
        : null;
    return {
      publicOfferKey: offer.publicOfferKey,
      mealPlan: offer.mealPlan,
      cancellation,
      freeCancellationUntil: until !== null && until >= c.today ? until : null,
      paymentMethods: [...(offer.paymentMethods ?? [])],
      totalMinor,
      nightlyMinor: totalMinor === null ? null : nightly(BigInt(totalMinor), nights),
      currency: offer.currency,
      withinBudget: withinBudget(c.search, totalMinor),
    };
  };

  /** A side read (reasons, next free dates): on failure the search answers without it. */
  const aside = async <T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      sources.log?.warn({ err: error }, `Live stay search: ${what} failed`);
      return fallback;
    }
  };

  /** The party on these dates: each room for all of it, else the fewest rooms it can book
   * together. With `full`, also why a free room's rates refuse the stay and, when nothing is
   * bookable, the next free dates; without, only whether it is bookable (to confirm later
   * dates). */
  async function evaluate(c: Context, dates: Dates, full: boolean): Promise<LiveStaySearchResult> {
    const { search } = c;
    const whole = await sources.stayPrices(
      c.slug,
      queryFor(dates, search, { adults: search.adults, childAges: search.childAges }),
      c.offered,
      c.budget,
    );
    if (!whole) return answer(search, dates, c.month, "not_bookable", c.childrenAccepted);
    const reads = new Map(whole.rooms.map((room) => [room.roomTypeId, room]));
    const rooms: LiveStayRoom[] = c.offered.rooms.map((room) => {
      const read = reads.get(room.roomTypeId);
      const prices = new Map(read?.offers.map((offer) => [offer.publicOfferKey, offer]));
      const rates = room.offers.flatMap((offer) => {
        const price = prices.get(offer.publicOfferKey);
        if (!price || price.status === "unavailable") return [];
        return [rateFor(c, dates, offer, price.status === "priced" ? price.totalMinor : null)];
      });
      return {
        roomTypeId: room.roomTypeId,
        name: room.name,
        occupancy: room.occupancy,
        status:
          !read || read.roomCount === null
            ? "too_small"
            : read.availability !== "available"
              ? "sold_out"
              : rates.length
                ? "available"
                : "closed",
        minNights: null,
        roomsLeft: rates.length ? (read?.roomsLeft ?? null) : null,
        rates,
      };
    });
    // More rooms only when no one room is bookable. From the rooms the party could book some of
    // (free, and their rates not refusing these dates): the fewest that take it with a room for
    // each, and one more when those can't be booked together.
    let split: LiveStaySplit | null = null;
    if (!rooms.some((room) => room.status === "available")) {
      const open = c.offered.rooms.filter(
        (room, index) =>
          (reads.get(room.roomTypeId)?.roomsFree ?? 0) >= 1 && rooms[index]!.status !== "closed",
      );
      const count = roomCountFor(search, open);
      if (count !== null) split = await splitFor(c, dates, count);
      if (count !== null && !split && count < Math.min(search.adults, MAX_ROOMS))
        if (placeable(search, count + 1, open)) split = await splitFor(c, dates, count + 1);
    }
    const bookable = rooms.some((room) => room.status === "available") || split !== null;
    const status = bookable ? "available" : "unavailable";
    const result = {
      ...answer(search, dates, c.month, status, c.childrenAccepted),
      rooms,
      split,
    };
    if (!full) return result;
    // Why free rooms' rates refuse the stay: from the published prices' own rules.
    const refused = rooms.filter((room) => room.status === "closed");
    if (refused.length) {
      const reasons = await aside(
        "reasons",
        () =>
          sources.refusals(
            c.slug,
            dates,
            {
              adults: search.adults,
              childAges: agesToPrice(search, search) ?? [],
            },
            c.offered.rooms.filter((room) =>
              refused.some((one) => one.roomTypeId === room.roomTypeId),
            ),
          ),
        new Map<string, Refusal>(),
      );
      for (const room of refused) {
        const reason = reasons.get(room.roomTypeId);
        if (!reason) continue;
        room.status = reason.status;
        room.minNights = reason.status === "minimum_stay" ? reason.minNights : null;
      }
    }
    if (bookable) return result;
    // The rooms the party needs: one when a room takes it all, else the fewest of the hotel's
    // rooms, free or not, with a room for each.
    const needed = rooms.some((room) => room.status !== "too_small")
      ? 1
      : roomCountFor(search, c.offered.rooms);
    if (needed === null) return { ...result, status: "no_fit" };
    return {
      ...result,
      nearestFree: await aside("next free dates", () => nearestFree(c, dates, needed), null),
    };
  }

  /** The cheapest set of `count` free rooms for the party, with rates the booking page books
   * together (paid the same way, with a way to pay they share), chosen by each room's own price
   * and then priced once as one booking. */
  async function splitFor(c: Context, dates: Dates, count: number): Promise<LiveStaySplit | null> {
    const slots = splitGuests(c.search, count);
    const keyOf = (guests: Guests) => JSON.stringify([guests.adults, guests.childAges]);
    const kinds = [...new Map(slots.map((slot) => [keyOf(slot), slot])).values()];
    const counts = kinds.map((kind) => slots.filter((slot) => keyOf(slot) === keyOf(kind)).length);
    const reads = await Promise.all(
      kinds.map((kind) =>
        sources.stayPrices(c.slug, queryFor(dates, c.search, kind), c.offered, c.budget),
      ),
    );
    if (reads.some((read) => !read)) return null;
    const types = c.offered.rooms;
    const option = (kind: number, type: number) =>
      reads[kind]!.rooms.find((room) => room.roomTypeId === types[type]!.roomTypeId);
    const free = types.map((_, type) =>
      Math.max(0, ...kinds.map((_, kind) => option(kind, type)?.roomsFree ?? 0)),
    );
    type Priced = Extract<StayPricesRead["rooms"][number]["offers"][number], { status: "priced" }>;
    let best: { total: bigint; rooms: { kind: number; type: number; offer: Priced }[] } | null =
      null;
    for (const group of paymentGroups(c.offered)) {
      const cheapest = (kind: number, type: number) => {
        const room = option(kind, type);
        if (!room || room.roomCount === null || room.availability !== "available") return null;
        return room.offers.reduce<Priced | null>(
          (low, offer) =>
            offer.status === "priced" &&
            group(offer) &&
            (!low || BigInt(offer.totalMinor) < BigInt(low.totalMinor))
              ? offer
              : low,
          null,
        );
      };
      const placed = cheapestRooms(counts, free, (kind, type) => {
        const offer = cheapest(kind, type);
        return offer ? BigInt(offer.totalMinor) : null;
      });
      if (!placed || (best && best.total <= placed.total)) continue;
      best = {
        total: placed.total,
        rooms: placed.assignment.map(([kind, type]) => ({
          kind,
          type,
          offer: cheapest(kind, type)!,
        })),
      };
    }
    if (!best) return null;
    // Rooms priced one by one count a booking's fixed charges each time; the booking counts
    // them once.
    const currency = best.rooms[0]!.offer.currency;
    const priced = await sources.selectionTotal(
      c.slug,
      dates,
      currency,
      best.rooms.map(({ kind, offer }) => ({
        publicOfferKey: offer.publicOfferKey,
        adults: kinds[kind]!.adults,
        childAges: agesToPrice(c.search, kinds[kind]!) ?? [],
      })),
    );
    if (!priced) return null;
    return {
      roomCount: count,
      totalMinor: priced.totalMinor,
      nightlyMinor: nightly(BigInt(priced.totalMinor), BigInt(nightsOf(dates))),
      currency,
      withinBudget: withinBudget(c.search, priced.totalMinor),
      rooms: best.rooms.map(({ kind, type, offer }) => {
        const room = types[type]!;
        return {
          roomTypeId: room.roomTypeId,
          name: room.name,
          adults: kinds[kind]!.adults,
          childAges: [...kinds[kind]!.childAges],
          rate: rateFor(
            c,
            dates,
            room.offers.find((one) => one.publicOfferKey === offer.publicOfferKey)!,
            null,
          ),
        };
      }),
    };
  }

  /** The first later arrival, within 60 days, for as many nights, that the party can book in
   * `needed` rooms: a few likely ones (`freeWindows`), each confirmed with its own prices. */
  async function nearestFree(c: Context, dates: Dates, needed: number) {
    const slots =
      needed === 1
        ? [{ adults: c.search.adults, children: c.search.childAges.length }]
        : splitParty(c.search.adults, c.search.childAges.length, needed);
    const windows = await sources.freeWindows(c.slug, dates, slots, c.offered);
    for (const window of windows) {
      const later = { checkIn: window.checkIn, checkOut: window.checkOut };
      // One room: the rates that found it free. More: every rate of those room types.
      const offered = narrow(c.offered, window.offers, needed > 1);
      const check = await evaluate({ ...c, offered }, later, false);
      // Priced, too: past the search's budget a rate is bookable but unchecked.
      if (check.split || check.rooms.some((room) => room.rates.some((rate) => rate.totalMinor)))
        return later;
    }
    return null;
  }

  return {
    /** Throws a TypeError for a search `parseLiveStaySearch` refuses. */
    async search(request: LiveStaySearch): Promise<LiveStaySearchResult> {
      const search = parseLiveStaySearch(request);
      if (!search) throw new TypeError("Invalid live stay search.");
      const place = await sources.property(search.propertyId);
      const today = stayToday(place?.timezone, now());
      const asked = search.stay;
      const month = "month" in asked ? asked.month : null;
      const first =
        "month" in asked
          ? (() => {
              const checkIn = `${asked.month}-01` < today ? today : `${asked.month}-01`;
              return { checkIn, checkOut: addDays(checkIn, asked.nights) };
            })()
          : asked;
      if (!place) return answer(search, first, month, "not_bookable");
      const accepted = place.childrenAccepted;
      if (first.checkIn < today || (month !== null && first.checkIn > monthEnd(month)))
        return answer(search, first, month, "past", accepted);
      const offered = await sources.offers(place.slug);
      const rooms = offered?.rooms.filter(
        (room) => !search.roomTypeId || room.roomTypeId === search.roomTypeId,
      );
      if (!rooms?.length) return answer(search, first, month, "not_bookable", accepted);
      if (search.childAges.length && !accepted)
        return answer(search, first, month, "no_fit", accepted);
      const c: Context = {
        search,
        slug: place.slug,
        offered: { ...offered!, rooms },
        today,
        month,
        childrenAccepted: accepted,
        budget: { left: SEARCH_BUDGET },
      };
      const result = await evaluate(c, first, true);
      // A month: its first arrival, else the next free one while still in that month.
      const later = result.nearestFree;
      if (month !== null && later && later.checkIn <= monthEnd(month)) {
        const found = await evaluate({ ...c, budget: { left: SEARCH_BUDGET } }, later, true);
        if (found.status === "available") return found;
      }
      return result;
    },
  };
}

/** A total per night, rounded half up to the minor unit. */
const nightly = (total: bigint, nights: bigint) =>
  ((total * 2n + nights) / (2n * nights)).toString();

const withinBudget = (search: LiveStaySearch, totalMinor: string | null) =>
  !search.budgetMinor || totalMinor === null
    ? null
    : BigInt(totalMinor) <= BigInt(search.budgetMinor);

/** One read-only snapshot on the display pool, always rolled back. */
async function inSnapshot<T>(pool: Pool, read: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await read(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

/**
 * The live search over the database, on a display pool of its own (`max` connections at once,
 * default 2, named apart from the agency page's): read-only and lock-free, so a search can write
 * nothing. `payments`: the booking page's own payment switches (as its route builds them from the
 * deployment's settings), so only the rates guests can pay now are offered, as on the page.
 */
export function createPgLiveStaySearch(config: {
  connectionString: string;
  payments: PricingPaymentSwitches;
  max?: number;
  log?: LiveStaySearchSources["log"];
}) {
  const pool = createPublicPricingDisplayPool({
    connectionString: config.connectionString,
    max: config.max ?? 2,
    applicationName: "vayada-live-stay-search",
  });
  const catalog = createPublicPricingOfferCatalog(pool, { payments: config.payments });
  const prices = createPublicPricingStayPrices(pool, catalog);
  const search = createLiveStaySearch({
    ...(config.log && { log: config.log }),
    property: (propertyId) =>
      inSnapshot(pool, async (client) => {
        // The canonical address, the hotel's calendar, and its booking page's children switch.
        const rows = await client.query<{
          slug: string;
          timezone: string | null;
          childrenAccepted: boolean;
        }>(
          `SELECT s.slug, location.timezone,
                  (revision.public_content
                    #> '{profile,hotel,supportedQuoteParameters,childrenSupported}')
                    IS DISTINCT FROM 'false'::jsonb AS "childrenAccepted"
             FROM hotel_catalog.property_slugs s
             LEFT JOIN hotel_catalog.property_locations location
               ON location.property_id = s.property_id
             LEFT JOIN distribution.active_public_booking_revision active
               ON active.property_id = s.property_id
             LEFT JOIN distribution.public_booking_content_revisions revision
               ON revision.id = active.content_revision_id
              AND revision.property_id = active.property_id
            WHERE s.property_id = $1::uuid AND s.locale IS NULL
              AND s.purpose = 'canonical' AND s.status = 'active'`,
          [propertyId],
        );
        return rows.rows.length === 1 ? rows.rows[0]! : null;
      }),
    offers: (slug) => catalog.read(slug),
    stayPrices: (slug, query, offered, budget) => prices.readOffered(slug, query, offered, budget),
    selectionTotal: (slug, dates, currency, rooms) =>
      prices.readSelection(slug, dates, currency, rooms),
    freeWindows: (slug, dates, slots, offered) =>
      readFreeWindows(pool, slug, dates, slots, offered, NEXT_FREE_TRIES),
    refusals: (slug, dates, guests, rooms) =>
      inSnapshot(pool, async (client) => {
        const refusals = new Map<string, Refusal>();
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return refusals;
        const offerIds = new Map(
          publicPricingOfferBindings(owner).map((binding) => [
            binding.publicOfferKey,
            binding.offerId,
          ]),
        );
        for (const listed of rooms) {
          const room = owner.publication.rooms.find((one) => one.roomTypeId === listed.roomTypeId);
          if (!room) continue;
          const ids = listed.offers.flatMap((offer) => offerIds.get(offer.publicOfferKey) ?? []);
          refusals.set(room.roomTypeId, roomRefusal(room, ids, dates, guests));
        }
        return refusals;
      }),
  });
  return { ...search, close: () => pool.end() };
}
