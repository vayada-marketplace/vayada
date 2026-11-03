import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgencyPage, getAgencyStayPrices, readAgencyPage } from "./agencyPage";

const page = {
  version: "agency-page.v1",
  slug: "the-travel-ubud",
  name: "The Travel Ubud",
  page: { title: "The Travel Ubud", description: "13 villas in and around Ubud" },
  header: {
    topLeft: "name",
    gallery: true,
    language: true,
    currency: false,
    contact: { email: null, whatsapp: "+6281234567890" },
    imageUrl: "https://images.vayada.com/agency.jpg",
  },
  design: {
    slug: "escape-villa",
    primaryColor: "#2b3033",
    fontPairing: "high-end-serif",
    currency: "USD",
    displayCurrencies: ["USD", "EUR"],
    displayDefaultCurrency: null,
  },
  locales: { default: "en", supported: ["en", "de"] },
  layout: { allowed: ["list"], default: "list" },
  results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: true },
  filters: {},
  stayPage: { nearby: true, map: true },
  stays: [
    {
      propertyId: "p1",
      slug: "escape-villa",
      name: "Escape Villa",
      propertyType: "villa",
      area: "Ubud",
      photoUrl: "https://images.vayada.com/escape.jpg",
      photos: [{ url: "https://images.vayada.com/escape.jpg", alt: null }, { url: "/local.jpg" }],
      currency: "USD",
      location: null,
      childrenEnabled: false,
    },
    { propertyId: "p2", slug: 7, name: "Broken" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("readAgencyPage", () => {
  it("keeps what the overview shows, https photos only, and drops a broken stay", () => {
    expect(readAgencyPage(page)).toEqual({
      slug: "the-travel-ubud",
      name: "The Travel Ubud",
      page: { title: "The Travel Ubud", description: "13 villas in and around Ubud" },
      header: {
        gallery: true,
        language: true,
        currency: false,
        contact: { email: null, whatsapp: "+6281234567890" },
        imageUrl: "https://images.vayada.com/agency.jpg",
      },
      design: page.design,
      locales: { default: "en", supported: ["en", "de"] },
      results: { defaultSort: "recommended", lowestPriceBadge: false, showFullStays: true },
      stays: [
        {
          propertyId: "p1",
          slug: "escape-villa",
          name: "Escape Villa",
          propertyType: "villa",
          area: "Ubud",
          photoUrl: "https://images.vayada.com/escape.jpg",
          photos: ["https://images.vayada.com/escape.jpg"],
          childrenEnabled: false,
        },
      ],
    });
  });

  it("falls back to the defaults for missing settings, and rejects another version", () => {
    const bare: Partial<typeof page> = { ...page };
    delete bare.results;
    delete bare.design;
    expect(readAgencyPage(bare)).toMatchObject({
      results: { defaultSort: "price_low", lowestPriceBadge: true, showFullStays: true },
      design: { slug: null, displayCurrencies: [] },
    });
    expect(() => readAgencyPage({ ...page, version: "agency-page.v2" })).toThrow();
  });

  it("reads the page same-origin, without a cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(page)));
    vi.stubGlobal("fetch", fetcher);
    await getAgencyPage("the-travel-ubud");
    expect(fetcher).toHaveBeenCalledWith("/api/booking-web/agency-pages/the-travel-ubud", {
      signal: undefined,
      cache: "no-store",
    });
  });
});

describe("getAgencyStayPrices", () => {
  const search = {
    checkIn: "2026-11-12",
    checkOut: "2026-11-14",
    adults: 4,
    children: 0,
    rooms: 2,
    promoCode: "AUTUMN",
  };
  const body = {
    version: "agency-stay-prices.v1",
    checkIn: "2026-11-12",
    checkOut: "2026-11-14",
    childrenPriced: true,
    stays: [
      {
        propertyId: "p1",
        slug: "escape-villa",
        status: "available",
        rooms: 2,
        roomTypesFree: 1,
        price: { totalMinor: "19000", nightlyMinor: "9500", currency: "USD", promoApplied: true },
        pricesComplete: true,
        nextFree: null,
      },
      {
        propertyId: "p2",
        slug: "uma",
        status: "unavailable",
        rooms: 2,
        roomTypesFree: 0,
        price: null,
        pricesComplete: true,
        nextFree: { checkIn: "2026-11-16", checkOut: "2026-11-18" },
      },
    ],
  };

  it("asks the API directly, so its limit counts this guest, and reads major units", async () => {
    vi.stubEnv("NEXT_PUBLIC_BOOKING_WEB_API_URL", "https://api.example/");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetcher);
    expect(await getAgencyStayPrices("the-travel-ubud", search)).toEqual({
      checkIn: "2026-11-12",
      checkOut: "2026-11-14",
      childrenPriced: true,
      stays: [
        {
          propertyId: "p1",
          status: "available",
          rooms: 2,
          roomTypesFree: 1,
          price: { total: 190, nightly: 95, currency: "USD", promoApplied: true },
          nextFree: null,
        },
        {
          propertyId: "p2",
          status: "unavailable",
          rooms: 2,
          roomTypesFree: 0,
          price: null,
          nextFree: { checkIn: "2026-11-16", checkOut: "2026-11-18" },
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example/api/booking-web/agency-pages/the-travel-ubud/stay-prices?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=0&rooms=2&promoCode=AUTUMN",
      { signal: undefined, cache: "no-store" },
    );
  });

  it("rejects an answer for other dates or with a broken price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...body, checkIn: "2026-11-13" }))),
    );
    await expect(getAgencyStayPrices("the-travel-ubud", search)).rejects.toThrow();
    const broken = structuredClone(body);
    broken.stays[0]!.price!.totalMinor = "95.00";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(broken))));
    await expect(getAgencyStayPrices("the-travel-ubud", search)).rejects.toThrow();
  });
});
