import type { Page, Request } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";

import { mockBookingApis } from "./bookingMocks";

/** The agency booking page of Timo's mockup (VAY-2450, "The Travel Ubud"), for VAY-2459 on. */
export const AGENCY_SLUG = "the-travel-ubud";

type Stay = {
  id: string;
  name: string;
  type: string;
  area: string;
  /** USD a night for two adults in one room. */
  nightly: number;
  hue: number;
  /** Full on every other date: free only on its `nextFree` nights, `days` after the search. */
  full?: { days: number };
};

// The page's "Recommended" order (Settings › Included properties).
export const AGENCY_STAYS: Stay[] = [
  {
    id: "escape",
    name: "The Escape Villa Ubud",
    type: "villa",
    area: "Ubud",
    nightly: 95,
    hue: 160,
  },
  {
    id: "mandala",
    name: "Mandala's Villa",
    type: "resort",
    area: "Peliatan",
    nightly: 110,
    hue: 30,
  },
  {
    id: "mertha",
    name: "Mertha Carik Guest House",
    type: "guesthouse",
    area: "Ubud",
    nightly: 38,
    hue: 90,
  },
  {
    id: "wiswan",
    name: "D'Wiswan Villa",
    type: "villa",
    area: "Penestanan",
    nightly: 72,
    hue: 200,
  },
  { id: "adhi", name: "Adhidrawa Ubud", type: "guesthouse", area: "Ubud", nightly: 45, hue: 260 },
  {
    id: "eskabbe",
    name: "Eskabbe Maha Villa",
    type: "villa",
    area: "Tegallalang road",
    nightly: 160,
    hue: 120,
  },
  {
    id: "tamarin",
    name: "The Tamarin Villas",
    type: "villa",
    area: "Penestanan",
    nightly: 128,
    hue: 10,
  },
  { id: "ranes", name: "Rane's Villa", type: "villa", area: "Ubud", nightly: 84, hue: 300 },
  {
    id: "uma",
    name: "Uma Nature Villa",
    type: "villa",
    area: "Ubud",
    nightly: 90,
    hue: 140,
    full: { days: 4 },
  },
  {
    id: "dewari",
    name: "Dewari Villa",
    type: "villa",
    area: "Ubud",
    nightly: 100,
    hue: 40,
    full: { days: 7 },
  },
];

export const staySlug = (id: string) => `${id}-ubud`;
const photo = (id: string, n = 1) => `https://images.vayada.com/agency-e2e/${id}-${n}.jpg`;

export function agencyPage(
  overrides: {
    header?: Record<string, unknown>;
    results?: Record<string, unknown>;
  } = {},
) {
  return {
    version: "agency-page.v1",
    slug: AGENCY_SLUG,
    name: "The Travel Ubud",
    page: {
      title: "The Travel Ubud",
      description: "13 villas, guest houses and resorts in and around Ubud",
    },
    header: {
      topLeft: "name",
      gallery: true,
      language: true,
      currency: true,
      contact: { email: "stay@thetravelubud.example", whatsapp: "+6281234567890" },
      imageUrl: photo("agency-hero"),
      ...overrides.header,
    },
    design: {
      slug: staySlug("escape"),
      primaryColor: "#2b3033",
      fontPairing: "grand-classic",
      currency: "USD",
      displayCurrencies: ["USD", "EUR"],
      displayDefaultCurrency: null,
    },
    locales: { default: "en", supported: ["en", "de"] },
    layout: { allowed: ["list", "split", "map"], default: "list" },
    results: {
      defaultSort: "price_low",
      lowestPriceBadge: true,
      showFullStays: true,
      ...overrides.results,
    },
    filters: {},
    stayPage: { nearby: true, map: true },
    stays: AGENCY_STAYS.map((stay) => ({
      propertyId: `property-${stay.id}`,
      slug: staySlug(stay.id),
      name: stay.name,
      propertyType: stay.type,
      area: stay.area,
      photoUrl: photo(stay.id),
      photos: [
        { url: photo(stay.id), alt: null },
        { url: photo(stay.id, 2), alt: null },
      ],
      currency: "USD",
      location: null,
      childrenEnabled: true,
    })),
  };
}

const day = (date: string, add: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
};

/** A search `days` from today, `nights` long, as YYYY-MM-DD. */
export function searchDates(days = 10, nights = 2) {
  const today = new Date();
  const start = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const checkIn = day(start.toISOString().slice(0, 10), days);
  return { checkIn, checkOut: day(checkIn, nights) };
}

/** What the API answers for one agency search: every stay priced for the search's rooms, a full
 * stay free only on its next free dates (`full.days` after `from`), AUTUMN off 10% at The Escape. */
export function stayPricesAnswer(url: URL, from: string) {
  const query = url.searchParams;
  const checkIn = query.get("checkIn")!;
  const checkOut = query.get("checkOut")!;
  const rooms = Number(query.get("rooms") ?? "1");
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
  const promo = query.get("promoCode");
  return {
    version: "agency-stay-prices.v1",
    checkIn,
    checkOut,
    childrenPriced: query.get("children") === "0",
    stays: AGENCY_STAYS.map((stay) => {
      const free = stay.full && {
        checkIn: day(from, stay.full.days),
        checkOut: day(from, stay.full.days + nights),
      };
      const base = {
        propertyId: `property-${stay.id}`,
        slug: staySlug(stay.id),
        rooms,
        pricesComplete: true,
      };
      if (free && free.checkIn !== checkIn)
        return { ...base, status: "unavailable", roomTypesFree: 0, price: null, nextFree: free };
      const promoApplied = promo === "AUTUMN" && stay.id === "escape";
      const nightly = stay.nightly * rooms * (promoApplied ? 90 : 100);
      return {
        ...base,
        status: "available",
        roomTypesFree: stay.id === "wiswan" ? 1 : 2,
        price: {
          totalMinor: String(nightly * nights),
          nightlyMinor: String(nightly),
          currency: "USD",
          promoApplied,
        },
        nextFree: null,
      };
    }),
  };
}

const svg = (hue: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},38%,62%)"/><stop offset="1" stop-color="hsl(${hue + 30},34%,32%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/></svg>`;

/**
 * The agency's address (`the-travel-ubud.<booking host>`) with its page, its stays' prices and
 * photos mocked; no hotel has the address. Returns the stay-price requests, in order.
 */
export async function mockAgencyPage(
  page: Page,
  options: {
    page?: ReturnType<typeof agencyPage>;
    from?: string;
    stayPrices?: (request: Request, url: URL) => { status: number; json: unknown } | null;
  } = {},
) {
  // The analytics choice is made, so its prompt doesn't cover the page.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: AGENCY_SLUG, version: CONSENT },
  );
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${AGENCY_SLUG}**`, (route) =>
    route.fulfill({
      status: 404,
      json: {
        statusCode: 404,
        error: "Not Found",
        message: "Booking Web hotel profile not found.",
      },
    }),
  );
  await page.route(new RegExp(`/api/booking-web/agency-pages/${AGENCY_SLUG}(?:\\?.*)?$`), (route) =>
    route.fulfill({ json: options.page ?? agencyPage() }),
  );
  const requests: URL[] = [];
  const from = options.from ?? searchDates().checkIn;
  await page.route(`**/api/booking-web/agency-pages/${AGENCY_SLUG}/stay-prices**`, (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const custom = options.stayPrices?.(route.request(), url);
    // A request the page cancelled (React's development effects) can't be answered.
    return route.fulfill(custom ?? { json: stayPricesAnswer(url, from) }).catch(() => undefined);
  });
  await page.route(`**/api/booking-web/hotels/${staySlug("escape")}/exchange-rates`, (route) =>
    route.fulfill({ json: { base: "USD", rates: { EUR: 0.9 } } }),
  );
  await page.route("https://images.vayada.com/agency-e2e/**", (route) => {
    const id = route
      .request()
      .url()
      .split("/")
      .pop()!
      .replace(/-\d+\.jpg$/, "");
    const hue = AGENCY_STAYS.find((stay) => stay.id === id)?.hue ?? 200;
    return route.fulfill({ contentType: "image/svg+xml", body: svg(hue) });
  });
  return requests;
}

/** The agency's address on the booking host the specs run on. */
export function agencyUrl(baseURL: string | undefined, path = "/") {
  const url = new URL(path, baseURL ?? "http://hotel-alpenrose.booking.localhost:3002");
  const labels = url.hostname.split(".");
  if (labels.length > 2) labels[0] = AGENCY_SLUG;
  url.hostname = labels.join(".");
  return url.toString();
}
