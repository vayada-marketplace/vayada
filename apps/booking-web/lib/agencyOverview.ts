import type {
  AccountBookingPageFilter,
  AccountBookingPageSort,
} from "@vayada/domain-booking/account-booking-page";
import type {
  AgencyRateFilter,
  AgencySearch,
  AgencyStay,
  AgencyStayPrice,
  AgencyStayPrices,
} from "@/services/api/agencyPage";
import { resolveLocale } from "@/lib/utils";
import { routing } from "@/i18n/routing";
import { metresBetween } from "@vayada/domain-hotels";

/** What a guest narrowed the stays to (VAY-2460). Type, area and private pool are the stay's;
 * breakfast and free cancellation price each card with only such rates; the price range is per
 * night, in whole units of the guest's display currency. */
export type AgencyFilters = {
  type: string | null;
  area: string | null;
  price: { min: number | null; max: number | null };
  privatePool: boolean;
  breakfast: boolean;
  freeCancellation: boolean;
};

export const NO_FILTERS: AgencyFilters = {
  type: null,
  area: null,
  price: { min: null, max: null },
  privatePool: false,
  breakfast: false,
  freeCancellation: false,
};

export const filtersActive = (filters: AgencyFilters) =>
  !!filters.type ||
  !!filters.area ||
  filters.price.min !== null ||
  filters.price.max !== null ||
  filters.privatePool ||
  filters.breakfast ||
  filters.freeCancellation;

/** The rates the cards are priced with: null for any rate. */
const rateFilterOf = (filters: AgencyFilters): AgencyRateFilter | null =>
  filters.breakfast && filters.freeCancellation
    ? "both"
    : filters.breakfast
      ? "breakfast"
      : filters.freeCancellation
        ? "freeCancellation"
        : null;

/** The stay's own facts match (these filters also narrow the full stays). */
const stayMatches = (stay: AgencyStay, filters: AgencyFilters) =>
  (!filters.type || stay.propertyType === filters.type) &&
  (!filters.area || stay.area === filters.area) &&
  (!filters.privatePool || stay.privatePool);

/** An available stay priced with only the filter's rates; null when it has none. */
function withRates(
  price: AgencyStayPrice,
  filter: AgencyRateFilter | null,
): AgencyStayPrice | null {
  if (!filter) return price;
  const one = price.status === "available" ? price.rateFilters?.[filter] : null;
  return one ? { ...price, roomTypesFree: one.roomTypesFree, price: one.price } : null;
}

/** The nightly price in the price filter's currency, rounded as cards show it; null when it
 * can't be converted. */
type PriceValue = (amount: number, currency: string) => number | null;

const nightlyIn = (price: AgencyStayPrice, value: PriceValue | undefined) => {
  if (price.status !== "available" || !price.price || !value) return null;
  const amount = value(price.price.nightly, price.price.currency);
  return amount === null ? null : Math.round(amount);
};

/** A stay card on the agency overview (VAY-2459). `price` is null while the search runs, when
 * it failed, or for a stay that couldn't be read ("unknown"). */
export type AgencyCard = {
  stay: AgencyStay;
  price: AgencyStayPrice | null;
  lowest: boolean;
};

export type AgencyResults = {
  /** Bookable stays (and, once the search answered, stays it couldn't read), sorted. */
  cards: AgencyCard[];
  /** Full for these dates, or too small for the party, in the page's order. */
  full: { stay: AgencyStay; price: AgencyStayPrice }[];
  available: number;
  total: number;
};

/**
 * The overview's cards for one search: available stays sorted as the guest chose (cheapest
 * first by default), stays without a comparable price after them in the page's "Recommended"
 * order, and full stays apart. The "Lowest price" badge marks the cheapest of two or more
 * compared stays. Stays in one currency compare as they are; across currencies through
 * `comparable` (one currency for all), which is null where no rate converts.
 *
 * VAY-2460 `filters`: type, area and private pool narrow every list; breakfast and free
 * cancellation price each available stay with only those rates and leave out stays without one
 * (also an unread stay, which can't be checked); the price range leaves out available stays
 * outside it, in the currency of `priceValue` (a stay it can't convert stays). `total` counts the
 * stays of the type, area and pool asked for.
 */
export function agencyResults(
  allStays: AgencyStay[],
  prices: AgencyStayPrices | null,
  sort: AccountBookingPageSort,
  options: {
    badge: boolean;
    comparable: (amount: number, currency: string) => number | null;
    filters?: AgencyFilters;
    priceValue?: PriceValue;
  },
): AgencyResults {
  const filters = options.filters ?? NO_FILTERS;
  const stays = allStays.filter((stay) => stayMatches(stay, filters));
  if (!prices)
    return {
      cards: stays.map((stay) => ({ stay, price: null, lowest: false })),
      full: [],
      available: 0,
      total: stays.length,
    };
  const byId = new Map(prices.stays.map((price) => [price.propertyId, price]));
  // A stay that is no longer public isn't in the answer: it isn't shown.
  const read = stays.flatMap((stay) => {
    const price = byId.get(stay.propertyId);
    return price ? [{ stay, price }] : [];
  });
  const rates = rateFilterOf(filters);
  const { min, max } = filters.price;
  const open = read.flatMap(({ stay, price: answered }) => {
    if (answered.status !== "available" && answered.status !== "unknown") return [];
    const price = withRates(answered, rates);
    if (!price) return [];
    const nightly = nightlyIn(price, options.priceValue);
    if (nightly !== null && ((min !== null && nightly < min) || (max !== null && nightly > max)))
      return [];
    return [{ stay, price }];
  });
  const currencies = new Set(
    open.flatMap(({ price }) =>
      price.status === "available" && price.price ? [price.price.currency] : [],
    ),
  );
  const nightly = (price: AgencyStayPrice) =>
    price.status !== "available" || !price.price
      ? null
      : currencies.size === 1
        ? price.price.nightly
        : options.comparable(price.price.nightly, price.price.currency);
  const priced = open.filter(({ price }) => nightly(price) !== null);
  const cheapest = priced.reduce<(typeof priced)[number] | null>(
    (best, card) => (best && nightly(best.price)! <= nightly(card.price)! ? best : card),
    null,
  );
  // Stable sorts: equal prices keep the page's order.
  const ordered =
    sort === "recommended"
      ? open
      : [
          ...priced
            .slice()
            .sort((a, b) =>
              sort === "price_high"
                ? nightly(b.price)! - nightly(a.price)!
                : nightly(a.price)! - nightly(b.price)!,
            ),
          ...open.filter((card) => !priced.includes(card)),
        ];
  const cards = ordered.map((card) => ({
    ...card,
    lowest: options.badge && priced.length > 1 && card === cheapest,
  }));
  return {
    cards,
    full: read.filter(({ price }) => price.status === "unavailable" || price.status === "no_fit"),
    available: open.filter(({ price }) => price.status === "available").length,
    total: read.length,
  };
}

/** Property types with their own words; another type shows as it is stored. */
const KNOWN_STAY_TYPES = [
  "hotel",
  "resort",
  "hostel",
  "apartment",
  "aparthotel",
  "guesthouse",
  "bed_and_breakfast",
  "homestay",
  "villa",
  "vacation_rental",
  "motel",
  "other",
];

/** A stay type in the guest's language (`t`: the "agency" messages). */
export const stayTypeName = (type: string, t: (key: string) => string) =>
  KNOWN_STAY_TYPES.includes(type) ? t(`type.${type}`) : type;

export const hasFilterChips = (options: AgencyFilterOptions) =>
  options.types.length > 0 ||
  options.areas.length > 0 ||
  !!options.price ||
  options.privatePool ||
  options.breakfast ||
  options.freeCancellation;

/** The filter chips a guest can use: only those the agency switched on, and only while they
 * split the page's stays (rate and price chips: the stays available for the search). A chip in
 * use always stays, so it can be undone. */
export type AgencyFilterOptions = {
  /** Property types and areas worth a chip, most stays first. */
  types: string[];
  areas: string[];
  privatePool: boolean;
  breakfast: boolean;
  freeCancellation: boolean;
  /** The available stays' lowest and highest price per night, null when the chip is hidden. */
  price: { min: number; max: number } | null;
};

export function agencyFilterOptions(
  stays: AgencyStay[],
  prices: AgencyStayPrices | null,
  enabled: Record<AccountBookingPageFilter, boolean>,
  filters: AgencyFilters,
  priceValue?: PriceValue,
): AgencyFilterOptions {
  const splits = (kept: number, of: number) => kept > 0 && kept < of;
  const choices = (on: boolean, values: (string | null)[], chosen: string | null) => {
    if (!on) return chosen ? [chosen] : [];
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    // Stable: equal counts keep the page's order.
    const listed = Array.from(counts.keys())
      .filter((value) => splits(counts.get(value)!, values.length))
      .sort((a, b) => counts.get(b)! - counts.get(a)!);
    return chosen && !listed.includes(chosen) ? [...listed, chosen] : listed;
  };
  const byId = new Map(prices?.stays.map((price) => [price.propertyId, price]) ?? []);
  const available = stays.flatMap((stay) => {
    const price = byId.get(stay.propertyId);
    return price?.status === "available" ? [price] : [];
  });
  const rateSplits = (filter: AgencyRateFilter) =>
    splits(available.filter((price) => price.rateFilters?.[filter]).length, available.length);
  const rates = rateFilterOf(filters);
  const nightly = available.flatMap((answered) => {
    const price = withRates(answered, rates);
    const value = price && nightlyIn(price, priceValue);
    return value === null || value === undefined ? [] : [value];
  });
  const priceSet = filters.price.min !== null || filters.price.max !== null;
  const low = Math.min(...nightly),
    high = Math.max(...nightly);
  return {
    types: choices(
      enabled.propertyType,
      stays.map((stay) => stay.propertyType),
      filters.type,
    ),
    areas: choices(
      enabled.area,
      stays.map((stay) => stay.area),
      filters.area,
    ),
    privatePool:
      filters.privatePool ||
      (enabled.privatePool &&
        splits(stays.filter((stay) => stay.privatePool).length, stays.length)),
    breakfast: filters.breakfast || (enabled.breakfast && rateSplits("breakfast")),
    freeCancellation:
      filters.freeCancellation || (enabled.freeCancellation && rateSplits("freeCancellation")),
    price:
      enabled.price && nightly.length && (low < high || priceSet)
        ? { min: low, max: high }
        : priceSet
          ? { min: filters.price.min ?? 0, max: filters.price.max ?? filters.price.min ?? 0 }
          : null,
  };
}

/** "Other stays nearby" on a stay's page (VAY-2461). */
export const NEARBY_STAYS = 8;

export type NearbyStay = {
  stay: AgencyStay;
  /** Straight-line distance from the stay whose page this is; null without both pins. */
  metres: number | null;
  /** Measured from or to a spot rounded to its area. */
  approximate: boolean;
};

/** The page's other stays, closest first (those without a pin after them, in the page's order),
 * at most `most`. */
export function nearbyStays(
  stays: AgencyStay[],
  current: AgencyStay,
  most = NEARBY_STAYS,
): NearbyStay[] {
  const from = current.map;
  return stays
    .filter((stay) => stay.slug !== current.slug)
    .map((stay) => ({
      stay,
      metres: from && stay.map ? metresBetween(from, stay.map) : null,
      approximate: !!(from?.approximate || stay.map?.approximate),
    }))
    .sort((a, b) =>
      a.metres === null || b.metres === null
        ? Number(a.metres === null) - Number(b.metres === null)
        : a.metres - b.metres,
    )
    .slice(0, most);
}

// A host whose first label is the page's slug, as the middleware reads it (`<slug>.localhost` too).
const BOOKING_HOST = /\.(?:next-booking\.vayada\.com|booking\.vayada\.com|localhost)(?::\d+)?$/;

/** The address's language prefix ("/de"), or "" for the default language. */
export function localePrefix(pathname: string): string {
  const first = pathname.split("/")[1] ?? "";
  return (routing.locales as readonly string[]).includes(first) ? `/${first}` : "";
}

/** The agency's address on a booking host: kept for local development (`?slug=`) elsewhere. */
const devSlug = (host: string, agencySlug: string, params: URLSearchParams) => {
  if (!BOOKING_HOST.test(host) || host.split(".")[0] !== agencySlug) params.set("slug", agencySlug);
};

/**
 * A stay's page on the agency's address for this search (VAY-2461): `/stays/<slug>`, in the
 * guest's language. `rooms` is said only past one, as the stay page reads it; a promo code only
 * where it applies. The children go as searched (a stay that takes none reads them as 0), and the
 * agency's own room count and code ride along where the stay's differ (`agencyRooms`,
 * `agencyPromo`), so "All stays" and the nearby stays keep the agency's search.
 */
export function stayHref(
  location: { protocol: string; host: string; pathname: string },
  agencySlug: string,
  staySlug: string,
  search: AgencySearch,
  stay: { rooms: number; promoApplied: boolean } | null,
): string {
  const params = new URLSearchParams({
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    adults: String(search.adults),
    children: String(search.children),
  });
  const rooms = stay?.rooms ?? search.rooms;
  if (rooms > 1) params.set("rooms", String(rooms));
  if (rooms !== search.rooms) params.set("agencyRooms", String(search.rooms));
  if (search.promoCode)
    params.set(stay?.promoApplied ? "promoCode" : "agencyPromo", search.promoCode);
  devSlug(location.host, agencySlug, params);
  return `${localePrefix(location.pathname)}/stays/${encodeURIComponent(staySlug)}?${params}`;
}

/** The agency's overview for the same search, from one of its stay pages. */
export function overviewHref(
  location: { host: string; pathname: string },
  agencySlug: string,
  search: string,
): string {
  const params = new URLSearchParams(search);
  devSlug(location.host, agencySlug, params);
  const query = params.toString();
  return `${localePrefix(location.pathname) || "/"}${query ? `?${query}` : ""}`;
}

const day = (date: string) => new Date(`${date}T00:00:00Z`);

/** "12 – 14 Nov" (or "30 Nov – 2 Dec") in the guest's language. */
export function formatStayRange(checkIn: string, checkOut: string, locale: string): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).formatRange(day(checkIn), day(checkOut));
}

/** Nights between two stay dates. */
export function stayNights(checkIn: string, checkOut: string): number {
  return Math.round((day(checkOut).getTime() - day(checkIn).getTime()) / 86_400_000);
}
