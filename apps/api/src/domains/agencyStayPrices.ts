import { parseStayPricesQuery, type StayPricesQuery } from "./publicPricingStayPrices.js";

/** One stay's room prices as the stay page reads them (`createPublicPricingStayPrices`). */
export type StayPrices = {
  rooms: {
    roomTypeId: string;
    roomCount: number | null;
    availability: "available" | "sold_out";
    roomsFree?: number;
    offers: (
      | { status: "priced"; totalMinor: string; currency: string; promoApplied: boolean }
      | { status: "unavailable" | "unpriced" }
    )[];
  }[];
};

/** The stays a live agency page shows, in its order (`readLiveAccountBookingPageStays`). */
export type AgencyPageStays = { stays: { propertyId: string; slug: string }[] } | null;

/** An agency page search: the party, and optionally its rooms, each with its own guests. */
export type AgencySearch = Omit<StayPricesQuery, "room"> & {
  rooms: { adults: number; children: number }[] | null;
};

/** A party never books more rooms than this on the booking page. */
const MAX_ROOMS = 9;
/** Stay prices kept per stay and search; prices shown, never the binding one (VAY-2458). */
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 2_000;

/** Query: as the stay page's (`checkIn`, `checkOut`, `adults`, `children`, `promoCode`), plus
 * `rooms` as each room's adults and children, `2-0,1-1`, adding up to the party. */
export function parseAgencyStayPricesQuery(query: unknown): AgencySearch | null {
  if (!query || typeof query !== "object") return null;
  const { rooms, roomAdults, roomChildren, ...rest } = query as Record<string, unknown>;
  if (roomAdults !== undefined || roomChildren !== undefined) return null;
  const stay = parseStayPricesQuery(rest);
  if (!stay) return null;
  if (rooms === undefined) return { ...stay, rooms: null };
  if (typeof rooms !== "string" || rooms.length > 60) return null;
  const parsed = rooms.split(",").map((room) => {
    const match = /^([1-9][0-9]?)-([0-9]{1,2})$/.exec(room);
    return match ? { adults: Number(match[1]), children: Number(match[2]) } : null;
  });
  if (parsed.length > MAX_ROOMS || parsed.some((room) => room === null)) return null;
  const split = parsed as { adults: number; children: number }[];
  const sum = (key: "adults" | "children") => split.reduce((total, room) => total + room[key], 0);
  return sum("adults") === stay.adults && sum("children") === stay.children
    ? { ...stay, rooms: split }
    : null;
}

export type AgencyStayResult = {
  propertyId: string;
  slug: string;
  /** "available": bookable for the search; "unavailable": full or closed for these dates (or
   * their length); "no_fit": no room takes the party (or a room of it); "unknown": not read. */
  status: "available" | "unavailable" | "no_fit" | "unknown";
  /** Room types the party (or a room of it) can book. */
  roomTypesFree: number;
  /** The cheapest priced way to book; null when nothing could be priced. */
  price: {
    totalMinor: string;
    nightlyMinor: string;
    currency: string;
    promoApplied: boolean;
  } | null;
  /** False when some bookable rates weren't priced, so a lower price may exist. */
  pricesComplete: boolean;
};

/**
 * VAY-2458: availability and the lowest price of every stay on a live agency page, for one search.
 * Each stay is read as its own page reads it, so cards show the stay page's prices; `stayPrices`
 * should run on the display pool, which takes no locks. A stay's promo code only prices that
 * stay. Reads are kept for a minute per stay and search; which stays the page shows is read fresh
 * each time, so a hidden stay disappears at once.
 */
export function createAgencyStayPrices(options: {
  pageStays: (slug: string) => Promise<AgencyPageStays>;
  stayPrices: (slug: string, query: StayPricesQuery) => Promise<StayPrices | null>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<StayPrices | null> }>();
  const read = (slug: string, query: StayPricesQuery) => {
    const key = JSON.stringify([
      slug,
      query.checkIn,
      query.checkOut,
      query.adults,
      query.children,
      query.promoCode,
      query.room ?? null,
    ]);
    const at = now(),
      hit = cache.get(key);
    if (hit && at - hit.at < CACHE_MS) return hit.value;
    const value = options.stayPrices(slug, query);
    cache.delete(key);
    cache.set(key, { at, value });
    // A failed read isn't kept.
    value.catch(() => cache.get(key)?.value === value && cache.delete(key));
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return value;
  };

  return {
    async read(pageSlug: string, search: AgencySearch) {
      const page = await options.pageStays(pageSlug);
      if (!page) return null;
      const nights = BigInt(
        (Date.parse(search.checkOut) - Date.parse(search.checkIn)) / 86_400_000,
      );
      const stays = await Promise.all(
        page.stays.map(async (stay): Promise<AgencyStayResult | null> => {
          try {
            const result = search.rooms
              ? await splitStay(stay.slug, search, search.rooms, read)
              : await wholeStay(stay.slug, search, read);
            return result && { ...stay, ...withNightly(result, nights) };
          } catch {
            return {
              ...stay,
              status: "unknown",
              roomTypesFree: 0,
              price: null,
              pricesComplete: false,
            };
          }
        }),
      );
      return {
        version: "agency-stay-prices.v1" as const,
        checkIn: search.checkIn,
        checkOut: search.checkOut,
        // Children count for rooms but aren't priced until /book knows their ages.
        childrenPriced: search.children === 0,
        // A stay that is no longer public isn't shown.
        stays: stays.filter((stay): stay is AgencyStayResult => stay !== null),
      };
    },
  };
}

type Read = (slug: string, query: StayPricesQuery) => Promise<StayPrices | null>;
type Priced = { totalMinor: string; currency: string; promoApplied: boolean };
type Result = Omit<AgencyStayResult, "propertyId" | "slug" | "price"> & { price: Priced | null };

const bookable = (room: StayPrices["rooms"][number]) =>
  room.availability === "available" && room.offers.some((offer) => offer.status !== "unavailable");
const cheapest = (room: StayPrices["rooms"][number]) =>
  room.offers.reduce<Priced | null>(
    (best, offer) =>
      offer.status === "priced" && (!best || BigInt(offer.totalMinor) < BigInt(best.totalMinor))
        ? {
            totalMinor: offer.totalMinor,
            currency: offer.currency,
            promoApplied: offer.promoApplied,
          }
        : best,
    null,
  );
const complete = (room: StayPrices["rooms"][number]) =>
  room.offers.every((offer) => offer.status !== "unpriced");

/** The whole party in rooms of one type, as many as it needs (the stay page's first view). */
async function wholeStay(slug: string, search: AgencySearch, read: Read): Promise<Result | null> {
  const prices = await read(slug, {
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    adults: search.adults,
    children: search.children,
    promoCode: search.promoCode,
  });
  if (!prices) return null;
  const free = prices.rooms.filter(bookable);
  const price = free
    .map(cheapest)
    .reduce<Priced | null>(
      (best, next) =>
        next && (!best || BigInt(next.totalMinor) < BigInt(best.totalMinor)) ? next : best,
      null,
    );
  return {
    status: free.length
      ? "available"
      : prices.rooms.some((room) => room.roomCount !== null)
        ? "unavailable"
        : "no_fit",
    roomTypesFree: free.length,
    price,
    pricesComplete: free.every(complete),
  };
}

/** Each room of the search priced on its own, as the stay page prices a group room by room
 * (VAY-2320); the cheapest set of free rooms from this one stay. */
async function splitStay(
  slug: string,
  search: AgencySearch,
  rooms: { adults: number; children: number }[],
  read: Read,
): Promise<Result | null> {
  const configs = [...new Map(rooms.map((room) => [`${room.adults}-${room.children}`, room]))];
  const reads = await Promise.all(
    configs.map(([, room]) =>
      read(slug, {
        checkIn: search.checkIn,
        checkOut: search.checkOut,
        adults: search.adults,
        children: search.children,
        promoCode: search.promoCode,
        room,
      }),
    ),
  );
  if (reads.some((prices) => !prices)) return null;
  const byConfig = reads as StayPrices[];
  const types = [...new Set(byConfig.flatMap((prices) => prices.rooms.map((r) => r.roomTypeId)))];
  const free = types.map((type) =>
    Math.max(
      0,
      ...byConfig.map((prices) => prices.rooms.find((r) => r.roomTypeId === type)?.roomsFree ?? 0),
    ),
  );
  const counts = configs.map(
    ([key]) => rooms.filter((room) => `${room.adults}-${room.children}` === key).length,
  );
  const option = (config: number, type: number) =>
    byConfig[config]!.rooms.find((room) => room.roomTypeId === types[type]);
  // Which room types each kind of room can book, at no cost: can the search be booked at all?
  const any = cheapestRooms(counts, free, (config, type) => {
    const room = option(config, type);
    return room && bookable(room) ? 0n : null;
  });
  // And the cheapest of the priced ways to book it.
  const priced = cheapestRooms(counts, free, (config, type) => {
    const room = option(config, type);
    const price = room && bookable(room) ? cheapest(room) : null;
    return price ? BigInt(price.totalMinor) : null;
  });
  const usable = types.filter((_, type) =>
    configs.some((_, config) => {
      const room = option(config, type);
      return room !== undefined && bookable(room);
    }),
  );
  const fits = configs.every((_, config) =>
    byConfig[config]!.rooms.some((room) => room.roomCount !== null),
  );
  const chosen = priced?.assignment.map(([config, type]) => cheapest(option(config, type)!)!);
  return {
    status: any ? "available" : fits ? "unavailable" : "no_fit",
    roomTypesFree: usable.length,
    price:
      any && priced && chosen
        ? {
            totalMinor: priced.total.toString(),
            currency: chosen[0]!.currency,
            promoApplied: chosen.some((price) => price.promoApplied),
          }
        : null,
    pricesComplete:
      !!priced &&
      types.every((_, type) =>
        configs.every((_, config) => {
          const room = option(config, type);
          return !room || !bookable(room) || complete(room);
        }),
      ),
  };
}

function withNightly(result: Result, nights: bigint) {
  return {
    ...result,
    price: result.price && {
      ...result.price,
      // Rounded half up to the minor unit.
      nightlyMinor: ((BigInt(result.price.totalMinor) * 2n + nights) / (2n * nights)).toString(),
    },
  };
}

/**
 * The cheapest way to place `counts[k]` rooms of each kind k in room types with `free[t]` rooms
 * left, where `cost(k, t)` is one room's price (null: that type can't take that kind of room).
 * A min-cost flow, kinds → types, small enough to solve exactly: at most nine rooms. Null when the
 * rooms can't all be placed. `assignment` lists [kind, type] once per room.
 */
export function cheapestRooms(
  counts: number[],
  free: number[],
  cost: (kind: number, type: number) => bigint | null,
): { total: bigint; assignment: [number, number][] } | null {
  const kinds = counts.length,
    types = free.length;
  const source = 0,
    sink = 1 + kinds + types,
    size = sink + 1;
  type Edge = { to: number; cap: number; cost: bigint; rev: number };
  const graph: Edge[][] = Array.from({ length: size }, () => []);
  const add = (from: number, to: number, cap: number, price: bigint) => {
    graph[from]!.push({ to, cap, cost: price, rev: graph[to]!.length });
    graph[to]!.push({ to: from, cap: 0, cost: -price, rev: graph[from]!.length - 1 });
  };
  counts.forEach((count, kind) => add(source, 1 + kind, count, 0n));
  free.forEach((left, type) => add(1 + kinds + type, sink, left, 0n));
  for (let kind = 0; kind < kinds; kind++)
    for (let type = 0; type < types; type++) {
      const price = cost(kind, type);
      if (price !== null) add(1 + kind, 1 + kinds + type, counts[kind]!, price);
    }
  const need = counts.reduce((sum, count) => sum + count, 0);
  let flow = 0,
    total = 0n;
  while (flow < need) {
    // Bellman-Ford: the cheapest path with room left (costs may be negative on the way back).
    const distance: (bigint | null)[] = Array(size).fill(null);
    const previous: ([number, number] | null)[] = Array(size).fill(null);
    distance[source] = 0n;
    for (let round = 0; round < size; round++) {
      let changed = false;
      graph.forEach((edges, node) => {
        const from = distance[node];
        if (from === null || from === undefined) return;
        edges.forEach((edge, index) => {
          const to = distance[edge.to];
          if (edge.cap > 0 && (to === null || to === undefined || from + edge.cost < to)) {
            distance[edge.to] = from + edge.cost;
            previous[edge.to] = [node, index];
            changed = true;
          }
        });
      });
      if (!changed) break;
    }
    if (distance[sink] === null) return null;
    let push = need - flow;
    for (let node = sink; node !== source; ) {
      const [from, index] = previous[node]!;
      push = Math.min(push, graph[from]![index]!.cap);
      node = from;
    }
    for (let node = sink; node !== source; ) {
      const [from, index] = previous[node]!;
      const edge = graph[from]![index]!;
      edge.cap -= push;
      graph[node]![edge.rev]!.cap += push;
      node = from;
    }
    flow += push;
    total += BigInt(push) * distance[sink]!;
  }
  const assignment: [number, number][] = [];
  for (let kind = 0; kind < kinds; kind++)
    for (const edge of graph[1 + kind]!) {
      const type = edge.to - 1 - kinds;
      if (type < 0 || type >= types) continue;
      // Flow sent along a kind → type edge sits on its reverse edge.
      for (let room = 0; room < graph[edge.to]![edge.rev]!.cap; room++)
        assignment.push([kind, type]);
    }
  return { total, assignment };
}
