import type { AccountBookingPageSort } from "@vayada/domain-booking/account-booking-page";
import type {
  AgencySearch,
  AgencyStay,
  AgencyStayPrice,
  AgencyStayPrices,
} from "@/services/api/agencyPage";
import { resolveLocale } from "@/lib/utils";

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
 */
export function agencyResults(
  stays: AgencyStay[],
  prices: AgencyStayPrices | null,
  sort: AccountBookingPageSort,
  options: { badge: boolean; comparable: (amount: number, currency: string) => number | null },
): AgencyResults {
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
  const open = read.filter(
    ({ price }) => price.status === "available" || price.status === "unknown",
  );
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
    available: read.filter(({ price }) => price.status === "available").length,
    total: read.length,
  };
}

/**
 * A stay's own booking page for this search. On a booking host (`<agency>.next-booking…`) it is
 * the stay's host; elsewhere (local development) the same origin with `?slug=`. `rooms` is said
 * only past one, as the stay page reads it; a promo code only where it applies.
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
  if (search.promoCode && stay?.promoApplied) params.set("promoCode", search.promoCode);
  const labels = location.host.split(".");
  const bookingHost =
    /\.(?:next-booking\.vayada\.com|booking\.vayada\.com|booking\.localhost)(?::\d+)?$/.test(
      location.host,
    );
  if (bookingHost && labels[0] === agencySlug) {
    labels[0] = staySlug;
    return `${location.protocol}//${labels.join(".")}${location.pathname}?${params}`;
  }
  params.set("slug", staySlug);
  return `${location.pathname}?${params}`;
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
