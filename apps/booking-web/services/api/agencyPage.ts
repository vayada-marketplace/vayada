import type { AccountBookingPageSort } from "@vayada/domain-booking/account-booking-page";
import { pricingCurrencyScale } from "@vayada/domain-booking/replacement-pricing";
import { bookingWebDirect, bookingWebPublic } from "./client";

/** One stay on an agency page (VAY-2459), in the page's "Recommended" order. */
export type AgencyStay = {
  propertyId: string;
  /** The stay's own booking address. */
  slug: string;
  name: string;
  propertyType: string | null;
  area: string | null;
  photoUrl: string | null;
  /** For the agency's gallery, grouped by stay. */
  photos: string[];
  childrenEnabled: boolean;
};

/** A live agency booking page (`GET /api/booking-web/agency-pages/:slug`, VAY-2459). */
export type AgencyPage = {
  slug: string;
  name: string;
  page: { title: string; description: string };
  header: {
    gallery: boolean;
    language: boolean;
    currency: boolean;
    /** Only while Contact is on. */
    contact: { email: string | null; whatsapp: string | null } | null;
    imageUrl: string | null;
  };
  /** The design stay's look, languages and display currencies. */
  design: {
    slug: string | null;
    primaryColor: string | null;
    fontPairing: string | null;
    currency: string | null;
    displayCurrencies: string[];
    displayDefaultCurrency: string | null;
  };
  locales: { default: string; supported: string[] } | null;
  results: {
    defaultSort: AccountBookingPageSort;
    lowestPriceBadge: boolean;
    showFullStays: boolean;
  };
  stays: AgencyStay[];
};

/** One agency search: the stay page's search, with `rooms` a room count (VAY-2458). */
export type AgencySearch = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
  promoCode: string | null;
};

export type AgencyStayPrice = {
  propertyId: string;
  /** "unavailable": full or closed for the dates; "no_fit": no room takes the party; "unknown":
   * not read this time. */
  status: "available" | "unavailable" | "no_fit" | "unknown";
  /** The rooms the price is for (the stay may need more than the search asked for). */
  rooms: number;
  roomTypesFree: number;
  /** Major units (e.g. 120.5), in `currency`. */
  price: { total: number; nightly: number; currency: string; promoApplied: boolean } | null;
  nextFree: { checkIn: string; checkOut: string } | null;
};

export type AgencyStayPrices = {
  checkIn: string;
  checkOut: string;
  /** False with children in the search: they are priced on the stay's page. */
  childrenPriced: boolean;
  stays: AgencyStayPrice[];
};

const SORTS: readonly string[] = ["price_low", "recommended", "price_high"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const https = (v: unknown) => (typeof v === "string" && v.startsWith("https://") ? v : null);
const invalid = (what: string) => new Error(`${what} could not be verified.`);

/** The agency page for this address; a 404 (no live page) rejects with ApiError 404. */
export async function getAgencyPage(slug: string, signal?: AbortSignal): Promise<AgencyPage> {
  const raw = await bookingWebPublic.get<unknown>(
    `/api/booking-web/agency-pages/${encodeURIComponent(slug)}`,
    { signal, cache: "no-store" },
  );
  return readAgencyPage(raw);
}

export function readAgencyPage(raw: unknown): AgencyPage {
  if (
    !object(raw) ||
    raw.version !== "agency-page.v1" ||
    typeof raw.slug !== "string" ||
    typeof raw.name !== "string" ||
    !object(raw.page) ||
    !object(raw.header) ||
    !Array.isArray(raw.stays)
  )
    throw invalid("Agency page");
  const header = raw.header;
  const design = object(raw.design) ? raw.design : {};
  const results = object(raw.results) ? raw.results : {};
  const locales = object(raw.locales) ? raw.locales : null;
  const contact = object(header.contact) ? header.contact : null;
  return {
    slug: raw.slug,
    name: raw.name,
    page: {
      title: text(raw.page.title) ?? raw.name,
      description: text(raw.page.description) ?? "",
    },
    header: {
      gallery: header.gallery !== false,
      language: header.language !== false,
      currency: header.currency !== false,
      contact:
        contact && (text(contact.email) || text(contact.whatsapp))
          ? { email: text(contact.email), whatsapp: text(contact.whatsapp) }
          : null,
      imageUrl: https(header.imageUrl),
    },
    design: {
      slug: text(design.slug),
      primaryColor: text(design.primaryColor),
      fontPairing: text(design.fontPairing),
      currency: text(design.currency),
      displayCurrencies: Array.isArray(design.displayCurrencies)
        ? design.displayCurrencies.filter((code): code is string => typeof code === "string")
        : [],
      displayDefaultCurrency: text(design.displayDefaultCurrency),
    },
    locales:
      locales && typeof locales.default === "string" && Array.isArray(locales.supported)
        ? {
            default: locales.default,
            supported: locales.supported.filter((code): code is string => typeof code === "string"),
          }
        : null,
    results: {
      defaultSort: SORTS.includes(results.defaultSort as string)
        ? (results.defaultSort as AccountBookingPageSort)
        : "price_low",
      lowestPriceBadge: results.lowestPriceBadge !== false,
      showFullStays: results.showFullStays !== false,
    },
    stays: raw.stays.flatMap((stay): AgencyStay[] => {
      if (
        !object(stay) ||
        typeof stay.propertyId !== "string" ||
        typeof stay.slug !== "string" ||
        typeof stay.name !== "string"
      )
        return [];
      const photos = Array.isArray(stay.photos)
        ? stay.photos.flatMap((photo) => {
            const url = object(photo) ? https(photo.url) : null;
            return url ? [url] : [];
          })
        : [];
      return [
        {
          propertyId: stay.propertyId,
          slug: stay.slug,
          name: stay.name,
          propertyType: text(stay.propertyType),
          area: text(stay.area),
          photoUrl: https(stay.photoUrl),
          photos,
          childrenEnabled: stay.childrenEnabled !== false,
        },
      ];
    }),
  };
}

/** Availability and the lowest price of every stay for one search (VAY-2458). Straight to the
 * API, so its per-address limit counts this guest. */
export async function getAgencyStayPrices(
  slug: string,
  search: AgencySearch,
  signal?: AbortSignal,
): Promise<AgencyStayPrices> {
  const params = new URLSearchParams({
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    adults: String(search.adults),
    children: String(search.children),
    rooms: String(search.rooms),
  });
  if (search.promoCode) params.set("promoCode", search.promoCode);
  const raw = await bookingWebDirect().get<unknown>(
    `/api/booking-web/agency-pages/${encodeURIComponent(slug)}/stay-prices?${params}`,
    { signal, cache: "no-store" },
  );
  signal?.throwIfAborted();
  if (
    !object(raw) ||
    raw.version !== "agency-stay-prices.v1" ||
    raw.checkIn !== search.checkIn ||
    raw.checkOut !== search.checkOut ||
    !Array.isArray(raw.stays)
  )
    throw invalid("Stay prices");
  return {
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    childrenPriced: raw.childrenPriced !== false,
    stays: raw.stays.map(stayPrice),
  };
}

const STATUSES: readonly string[] = ["available", "unavailable", "no_fit", "unknown"];
const count = (v: unknown, min: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= 999;

function stayPrice(stay: unknown): AgencyStayPrice {
  if (
    !object(stay) ||
    typeof stay.propertyId !== "string" ||
    !STATUSES.includes(stay.status as string) ||
    !count(stay.rooms, 1) ||
    !count(stay.roomTypesFree, 0)
  )
    throw invalid("Stay prices");
  const next = stay.nextFree;
  return {
    propertyId: stay.propertyId,
    status: stay.status as AgencyStayPrice["status"],
    rooms: stay.rooms as number,
    roomTypesFree: stay.roomTypesFree as number,
    price: stay.price === null || stay.price === undefined ? null : money(stay.price),
    nextFree:
      object(next) &&
      typeof next.checkIn === "string" &&
      typeof next.checkOut === "string" &&
      DATE.test(next.checkIn) &&
      DATE.test(next.checkOut)
        ? { checkIn: next.checkIn, checkOut: next.checkOut }
        : null,
  };
}

function money(price: unknown): AgencyStayPrice["price"] {
  const minor = /^(0|[1-9][0-9]*)$/;
  if (
    !object(price) ||
    typeof price.totalMinor !== "string" ||
    typeof price.nightlyMinor !== "string" ||
    !minor.test(price.totalMinor) ||
    !minor.test(price.nightlyMinor) ||
    typeof price.currency !== "string" ||
    typeof price.promoApplied !== "boolean"
  )
    throw invalid("Stay prices");
  const scale = pricingCurrencyScale(price.currency);
  if (scale === null) throw invalid("Stay prices");
  return {
    total: Number(price.totalMinor) / 10 ** scale,
    nightly: Number(price.nightlyMinor) / 10 ** scale,
    currency: price.currency,
    promoApplied: price.promoApplied,
  };
}
