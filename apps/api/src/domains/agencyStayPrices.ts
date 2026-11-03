import {
  fewestRooms,
  parseStayPricesQuery,
  type StayPricesQuery,
} from "./publicPricingStayPrices.js";

type Party = { adults: number; children: number };

/** One stay's room prices as the stay page reads them (`createPublicPricingStayPrices`). */
export type StayPrices = {
  /** The fewest free rooms the whole party needs, mixing types; null when none take it. */
  suggestedRooms?: number | null;
  rooms: {
    roomTypeId: string;
    roomCount: number | null;
    availability: "available" | "sold_out";
    roomsFree?: number;
    offers: (
      | {
          publicOfferKey: string;
          status: "priced";
          totalMinor: string;
          currency: string;
          promoApplied: boolean;
        }
      | { publicOfferKey: string; status: "unavailable" | "unpriced" }
    )[];
  }[];
};

/** A stay's rooms and rates as its booking page offers them (`createPublicPricingOfferCatalog`). */
export type StayOffers = {
  rooms: {
    roomTypeId: string;
    occupancy: { maxGuests: number; maxAdults: number; maxChildren: number };
    offers: {
      publicOfferKey: string;
      currency: string;
      paymentMethods?: readonly string[] | null;
      paymentSchedule?: { kind: string; key?: string } | null;
    }[];
  }[];
};

/** The stays a live agency page shows, in its order (`readLiveAccountBookingPageStays`). A stay
 * whose page takes no children counts none, as its page does. */
export type AgencyPageStays = {
  stays: { propertyId: string; slug: string; childrenEnabled?: boolean }[];
} | null;

/** An agency page search: the stay page's, with its room count (`rooms`, 1 unless asked). */
export type AgencySearch = Omit<StayPricesQuery, "room"> & { rooms: number };

/** Later dates that may take the party's rooms (`readFreeWindows`), first first, each with the
 * rates that found it free. */
export type FreeWindow = {
  checkIn: string;
  checkOut: string;
  offers: { roomTypeId: string; publicOfferKey: string }[];
};

type Log = { warn(fields: object, message: string): void };

/** A party never books more rooms than this on the booking page. */
const MAX_ROOMS = 9;
/** Agency searches are for holidays: longer stays are searched on the stay's own page. */
export const AGENCY_MAX_NIGHTS = 30;
/** Each stay's answer is kept per search; prices shown, never the binding one (VAY-2458). */
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 2_000;
/** Offers priced for one search across all its stays; past it they are "unpriced". */
const SEARCH_BUDGET = 500;
/** Searches computed at once; past it, guests are asked to try again in a moment. */
const MAX_SEARCHES = 4;
/** Later windows confirmed with the stay's own price read before giving up on next free dates. */
export const NEXT_FREE_TRIES = 3;

const DAY = 86_400_000;
const nightsOf = (dates: { checkIn: string; checkOut: string }) =>
  Math.round((Date.parse(dates.checkOut) - Date.parse(dates.checkIn)) / DAY);

/** Query: the stay page's (`checkIn`, `checkOut`, `adults`, `children`, `promoCode`, and `rooms`
 * as the number of rooms, 1 to 9 and never more than the adults), at most 30 nights. */
export function parseAgencyStayPricesQuery(query: unknown): AgencySearch | null {
  if (!query || typeof query !== "object") return null;
  const { rooms, roomAdults, roomChildren, ...rest } = query as Record<string, unknown>;
  if (roomAdults !== undefined || roomChildren !== undefined) return null;
  const stay = parseStayPricesQuery(rest);
  if (!stay || nightsOf(stay) > AGENCY_MAX_NIGHTS) return null;
  if (rooms === undefined) return { ...stay, rooms: 1 };
  if (typeof rooms !== "string" || !/^[1-9]$/.test(rooms)) return null;
  return Number(rooms) <= stay.adults ? { ...stay, rooms: Number(rooms) } : null;
}

/** A group's guests over its rooms as the stay page spreads them (booking-web `splitParty`):
 * adults evenly, the first rooms taking any remainder, and children in the rooms with the fewest
 * adults, last rooms first. */
export function splitParty(adults: number, children: number, rooms: number): Party[] {
  const count = Math.max(1, Math.min(rooms, adults));
  const split = Array.from({ length: count }, (_, index) => ({
    adults: Math.floor(adults / count) + (index < adults % count ? 1 : 0),
    children: 0,
  }));
  const order = split
    .map((_, index) => index)
    .sort((a, b) => split[a]!.adults - split[b]!.adults || b - a);
  for (let child = 0; child < children; child++) split[order[child % order.length]!]!.children++;
  return split;
}

/** The most rooms the stay page offers a party (booking-web `mostRooms`). */
const mostRooms = (adults: number, fewest: number) =>
  Math.max(1, Math.min(adults, MAX_ROOMS, Math.max(4, fewest)));

export type AgencyStayResult = {
  propertyId: string;
  slug: string;
  /** "available": bookable for the search; "unavailable": full or closed for these dates (or
   * their length); "no_fit": no room takes the party (or a room of it); "unknown": not read. */
  status: "available" | "unavailable" | "no_fit" | "unknown";
  /** The rooms everything here is for: the search's; or, searching one room, the fewest rooms
   * the stay needs when no one room takes the party. The stay page shows the same with `rooms`. */
  rooms: number;
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
  /** For an unavailable stay: the first later dates of the same length, within 60 days, when its
   * rooms take the party; null when there are none (or for any other status). */
  nextFree: { checkIn: string; checkOut: string } | null;
};

/** Thrown while the most searches run at once; the route answers 503 with Retry-After. */
export class AgencyStayPricesBusy extends Error {
  constructor() {
    super("Agency stay prices are busy.");
  }
}

/**
 * VAY-2458: availability and the lowest price of every stay on a live agency page, for one search.
 * Each stay is read as its own page reads it (`readOffered` over its offers), so cards show the
 * stay page's prices; both should run on the display pool, which takes no locks. A stay's promo
 * code only prices that stay. Each stay's answer is kept for a minute per search; which stays the
 * page shows is read fresh each time, so a hidden stay disappears at once.
 */
export function createAgencyStayPrices(options: {
  pageStays: (slug: string) => Promise<AgencyPageStays>;
  /** The page's stays that have this promo code (`readStaysWithPromoCode`); without it, all. */
  promoStays?: (propertyIds: string[], code: string) => Promise<ReadonlySet<string>>;
  offers: (slug: string) => Promise<StayOffers | null>;
  stayPrices: (
    slug: string,
    query: StayPricesQuery,
    offered: StayOffers,
    budget: { left: number },
  ) => Promise<StayPrices | null>;
  /** Later windows that may take the party's rooms (`readFreeWindows`), at most a few. */
  freeWindows?: (
    slug: string,
    dates: { checkIn: string; checkOut: string },
    slots: Party[],
    offered: StayOffers,
  ) => Promise<FreeWindow[]>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<Outcome | null> }>();
  let searching = 0;

  /** One stay's answer, kept for a minute while `keep` says so; a failed read isn't kept. */
  const cached = (
    key: string,
    compute: () => Promise<Outcome | null>,
    keep: (outcome: Outcome | null) => boolean,
  ) => {
    const at = now(),
      hit = cache.get(key);
    if (hit && at - hit.at < CACHE_MS) return hit.value;
    const value = compute();
    cache.delete(key);
    cache.set(key, { at, value });
    const drop = () => cache.get(key)?.value === value && cache.delete(key);
    value.then((outcome) => keep(outcome) || drop(), drop);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return value;
  };

  async function outcome(
    stay: { propertyId: string; slug: string },
    search: AgencySearch,
    budget: { left: number },
    log: Log | undefined,
  ): Promise<Outcome | null> {
    const offered = await options.offers(stay.slug);
    // No longer public.
    if (!offered) return null;
    const read: Read = (query, offers) => options.stayPrices(stay.slug, query, offers, budget);
    const view = await stayView(read, search, offered);
    if (!view) return null;
    let nextFree: AgencyStayResult["nextFree"] = null;
    if (view.status === "unavailable" && options.freeWindows) {
      try {
        const windows = await options.freeWindows(
          stay.slug,
          search,
          splitParty(search.adults, search.children, view.rooms),
          offered,
        );
        // The stay's own price read confirms a window, with the rates that found it free.
        for (const window of windows) {
          const dates = { ...search, checkIn: window.checkIn, checkOut: window.checkOut };
          // One room: the one rate. More: every rate of those room types, so rates the page
          // books together can be found.
          const rates = narrow(offered, window.offers, view.rooms > 1);
          const confirmed = await viewFor(read, dates, view.rooms, rates);
          // Priced, too: past the search's budget an offer is bookable but unchecked.
          if (confirmed?.status === "available" && confirmed.price) {
            nextFree = { checkIn: window.checkIn, checkOut: window.checkOut };
            break;
          }
        }
      } catch (error) {
        // Without next free dates the card still shows the stay as unavailable.
        log?.warn({ err: error, propertyId: stay.propertyId }, "Agency next free dates failed");
      }
    }
    return {
      status: view.status,
      rooms: view.rooms,
      roomTypesFree: view.roomTypesFree,
      price: withNightly(view.price, BigInt(nightsOf(search))),
      pricesComplete: view.pricesComplete,
      nextFree,
    };
  }

  return {
    async read(pageSlug: string, search: AgencySearch, context: { log?: Log } = {}) {
      if (searching >= MAX_SEARCHES) throw new AgencyStayPricesBusy();
      searching++;
      try {
        const page = await options.pageStays(pageSlug);
        if (!page) return null;
        // A code only prices the stays that have it; for the rest it is no code (and their
        // answer is the one kept without a code).
        const withCode =
          search.promoCode && options.promoStays && page.stays.length
            ? await options.promoStays(
                page.stays.map((stay) => stay.propertyId),
                search.promoCode,
              )
            : null;
        const budget = { left: SEARCH_BUDGET };
        const stays = await Promise.all(
          page.stays.map(
            async ({ propertyId, slug, childrenEnabled }): Promise<AgencyStayResult | null> => {
              const stay = { propertyId, slug };
              const own: AgencySearch = {
                ...search,
                children: childrenEnabled === false ? 0 : search.children,
                promoCode: !withCode || withCode.has(propertyId) ? search.promoCode : null,
              };
              const key = JSON.stringify([
                stay.slug,
                own.checkIn,
                own.checkOut,
                own.adults,
                own.children,
                own.rooms,
                own.promoCode,
              ]);
              try {
                // Not kept: a stay that isn't public now (it may be again in a moment), or an
                // answer past the search's budget (a later search may price it all).
                const result = await cached(
                  key,
                  () => outcome(stay, own, budget, context.log),
                  (kept) => kept !== null && budget.left > 0,
                );
                return result && { ...stay, ...result };
              } catch (error) {
                context.log?.warn(
                  { err: error, propertyId: stay.propertyId },
                  "Agency stay prices failed",
                );
                return {
                  ...stay,
                  status: "unknown" as const,
                  rooms: search.rooms,
                  roomTypesFree: 0,
                  price: null,
                  pricesComplete: false,
                  nextFree: null,
                };
              }
            },
          ),
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
      } finally {
        searching--;
      }
    },
  };
}

type Read = (query: StayPricesQuery, offered: StayOffers) => Promise<StayPrices | null>;
type Room = StayPrices["rooms"][number];
type Offer = Room["offers"][number];
type Priced = { totalMinor: string; currency: string; promoApplied: boolean };
type View = Omit<AgencyStayResult, "propertyId" | "slug" | "price" | "nextFree"> & {
  price: Priced | null;
  suggestedRooms: number | null;
};
type Outcome = Omit<AgencyStayResult, "propertyId" | "slug">;

const any = () => true;
const usable = (room: Room, allowed: (offer: Offer) => boolean = any) =>
  room.availability === "available" &&
  room.offers.some((offer) => offer.status !== "unavailable" && allowed(offer));
const cheapest = (room: Room, allowed: (offer: Offer) => boolean = any) =>
  room.offers.reduce<Priced | null>(
    (best, offer) =>
      offer.status === "priced" &&
      allowed(offer) &&
      (!best || BigInt(offer.totalMinor) < BigInt(best.totalMinor))
        ? {
            totalMinor: offer.totalMinor,
            currency: offer.currency,
            promoApplied: offer.promoApplied,
          }
        : best,
    null,
  );
const complete = (room: Room) => room.offers.every((offer) => offer.status !== "unpriced");
const searchFor = (search: AgencySearch, room: Party): StayPricesQuery => ({
  checkIn: search.checkIn,
  checkOut: search.checkOut,
  adults: search.adults,
  children: search.children,
  promoCode: search.promoCode,
  room,
});

/**
 * The stay as its page shows the search. One room: the whole party in one room, as the page
 * opens; when no free room takes it all, the fewest free rooms that do (the page offers that
 * count); when nothing is free, the rooms the stay would need, for next free dates. More rooms:
 * that many, as many as the page offers the party.
 */
async function stayView(read: Read, search: AgencySearch, offered: StayOffers) {
  if (search.rooms === 1) {
    const one = await viewFor(read, search, 1, offered);
    if (!one || one.status === "available") return one && { ...one, rooms: 1 };
    const fewest = one.suggestedRooms;
    let split = null;
    if (fewest !== null && fewest >= 2) {
      split = await viewFor(read, search, fewest, offered);
      if (!split) return null;
      if (split.status === "available") return { ...split, rooms: fewest };
    }
    if (one.status === "unavailable") return { ...one, rooms: 1 };
    // No room takes the whole party: the fewest of the stay's rooms that could, free or not.
    const needed = fewestRooms(offered.rooms, search);
    if (needed === null || needed < 2) return { ...one, rooms: 1 };
    const other = split && fewest === needed ? split : await viewFor(read, search, needed, offered);
    return other && { ...other, rooms: needed };
  }
  const view = await viewFor(read, search, search.rooms, offered);
  if (!view) return null;
  const most = mostRooms(search.adults, view.suggestedRooms ?? 1);
  if (search.rooms <= most) return { ...view, rooms: search.rooms };
  const fewer = await viewFor(read, search, most, offered);
  return fewer && { ...fewer, rooms: most };
}

/** The party in `count` rooms: one room for all, or each room priced on its own as the page
 * prices a group room by room (VAY-2320), the cheapest set of free rooms from this one stay. */
async function viewFor(
  read: Read,
  search: AgencySearch,
  count: number,
  offered: StayOffers,
): Promise<View | null> {
  if (count === 1) {
    const prices = await read(
      searchFor(search, { adults: search.adults, children: search.children }),
      offered,
    );
    if (!prices) return null;
    const free = prices.rooms.filter((room) => usable(room));
    return {
      status: free.length
        ? "available"
        : prices.rooms.some((room) => room.roomCount !== null)
          ? "unavailable"
          : "no_fit",
      rooms: 1,
      roomTypesFree: free.length,
      price: lowest(free.map((room) => cheapest(room))),
      pricesComplete: free.every(complete),
      suggestedRooms: prices.suggestedRooms ?? null,
    };
  }
  const slots = splitParty(search.adults, search.children, count);
  const kinds = [...new Map(slots.map((slot) => [`${slot.adults}-${slot.children}`, slot]))];
  const counts = kinds.map(
    ([key]) => slots.filter((slot) => `${slot.adults}-${slot.children}` === key).length,
  );
  const reads = await Promise.all(kinds.map(([, kind]) => read(searchFor(search, kind), offered)));
  if (reads.some((prices) => !prices)) return null;
  const byKind = reads as StayPrices[];
  const types = [...new Set(byKind.flatMap((prices) => prices.rooms.map((r) => r.roomTypeId)))];
  const free = types.map((type) =>
    Math.max(
      0,
      ...byKind.map((prices) => prices.rooms.find((r) => r.roomTypeId === type)?.roomsFree ?? 0),
    ),
  );
  const option = (kind: number, type: number) =>
    byKind[kind]!.rooms.find((room) => room.roomTypeId === types[type]);
  // The page combines only rates paid the same way, with a way to pay they share
  // (booking-web `combinable`): each such group of rates is tried on its own.
  let bookable = false,
    best: { total: bigint; price: Priced } | null = null;
  for (const allowed of paymentGroups(offered)) {
    if (
      cheapestRooms(counts, free, (kind, type) => {
        const room = option(kind, type);
        return room && usable(room, allowed) ? 0n : null;
      })
    )
      bookable = true;
    const priced = cheapestRooms(counts, free, (kind, type) => {
      const room = option(kind, type);
      const price = room && usable(room, allowed) ? cheapest(room, allowed) : null;
      return price ? BigInt(price.totalMinor) : null;
    });
    if (!priced || (best && best.total <= priced.total)) continue;
    const chosen = priced.assignment.map(([kind, type]) => cheapest(option(kind, type)!, allowed)!);
    best = {
      total: priced.total,
      price: {
        totalMinor: priced.total.toString(),
        currency: chosen[0]!.currency,
        promoApplied: chosen.some((price) => price.promoApplied),
      },
    };
  }
  const fits = byKind.every((prices) => prices.rooms.some((room) => room.roomCount !== null));
  return {
    status: bookable ? "available" : fits ? "unavailable" : "no_fit",
    rooms: count,
    roomTypesFree: types.filter((_, type) =>
      kinds.some((_, kind) => {
        const room = option(kind, type);
        return !!room && usable(room);
      }),
    ).length,
    price: bookable ? (best?.price ?? null) : null,
    // Nothing to price when it can't be booked.
    pricesComplete:
      (!bookable || !!best) &&
      types.every((_, type) =>
        kinds.every((_, kind) => {
          const room = option(kind, type);
          return !room || !usable(room) || complete(room);
        }),
      ),
    suggestedRooms: byKind[0]!.suggestedRooms ?? null,
  };
}

/** Which rates may be booked together, one group per way of paying: rates paid the same way
 * (full, or the same deposit), and one way to pay they all accept. */
function paymentGroups(offered: StayOffers): ((offer: Offer) => boolean)[] {
  const terms = new Map(
    offered.rooms.flatMap((room) =>
      room.offers.map((offer) => [
        offer.publicOfferKey,
        {
          schedule: offer.paymentSchedule
            ? offer.paymentSchedule.kind === "deposit"
              ? `deposit:${offer.paymentSchedule.key}`
              : offer.paymentSchedule.kind
            : null,
          methods: offer.paymentMethods ?? null,
        },
      ]),
    ),
  );
  const values = [...terms.values()];
  const schedules = [null, ...new Set(values.flatMap((term) => term.schedule ?? []))];
  const methods = [null, ...new Set(values.flatMap((term) => term.methods ?? []))];
  return schedules.flatMap((schedule) =>
    methods.map((method) => (offer: Offer) => {
      const term = terms.get(offer.publicOfferKey);
      if (!term) return false;
      return (
        (term.schedule === null || term.schedule === schedule) &&
        (term.methods === null || (method !== null && term.methods.includes(method)))
      );
    }),
  );
}

/** The stay's offers cut to the rates that found a window free, or to their room types. */
function narrow(
  offered: StayOffers,
  offers: FreeWindow["offers"],
  wholeTypes: boolean,
): StayOffers {
  return {
    rooms: offered.rooms.flatMap((room) => {
      const kept = room.offers.filter((offer) =>
        offers.some(
          (one) =>
            one.roomTypeId === room.roomTypeId &&
            (wholeTypes || one.publicOfferKey === offer.publicOfferKey),
        ),
      );
      return kept.length ? [{ ...room, offers: kept }] : [];
    }),
  };
}

const lowest = (prices: (Priced | null)[]) =>
  prices.reduce<Priced | null>(
    (best, next) =>
      next && (!best || BigInt(next.totalMinor) < BigInt(best.totalMinor)) ? next : best,
    null,
  );

function withNightly(price: Priced | null, nights: bigint) {
  return (
    price && {
      ...price,
      // Rounded half up to the minor unit.
      nightlyMinor: ((BigInt(price.totalMinor) * 2n + nights) / (2n * nights)).toString(),
    }
  );
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
