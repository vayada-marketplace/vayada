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
  filters: { propertyType: true, price: true, privatePool: false, breakfast: "yes" },
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
      map: null,
      privatePool: true,
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
      // Only chips switched on; anything else is off.
      filters: {
        propertyType: true,
        area: false,
        price: true,
        privatePool: false,
        breakfast: false,
        freeCancellation: false,
        bedrooms: false,
      },
      layout: { allowed: ["list"], default: "list" },
      stayPage: { nearby: true, map: true },
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
          privatePool: true,
          map: null,
          units: null,
        },
      ],
    });
  });

  it("reads the stay page's switches, on unless the agency turned them off (VAY-2461)", () => {
    expect(readAgencyPage({ ...page, stayPage: { nearby: false } }).stayPage).toEqual({
      nearby: false,
      map: true,
    });
    expect(readAgencyPage({ ...page, stayPage: undefined }).stayPage).toEqual({
      nearby: true,
      map: true,
    });
  });

  it("keeps each stay's rooms in use, for its stay page (VAY-2461)", () => {
    const units = (value: unknown) =>
      readAgencyPage({ ...page, stays: [{ ...page.stays[0], units: value }] }).stays[0]!.units;
    expect(units(2)).toBe(2);
    for (const value of [0, -1, 1.5, "2", null]) expect(units(value)).toBeNull();
  });

  it("keeps the layouts allowed (List always) and each stay's pin (VAY-2460)", () => {
    const read = (layout: unknown, map: unknown) =>
      readAgencyPage({ ...page, layout, stays: [{ ...page.stays[0], map }] });
    expect(
      read(
        { allowed: ["map", "split"], default: "map" },
        {
          latitude: -8.51,
          longitude: 115.27,
          approximate: true,
        },
      ),
    ).toMatchObject({
      layout: { allowed: ["list", "split", "map"], default: "map" },
      stays: [{ map: { latitude: -8.51, longitude: 115.27, approximate: true } }],
    });
    // A default it doesn't allow, or none: List.
    expect(read({ allowed: ["split"], default: "map" }, null).layout).toEqual({
      allowed: ["list", "split"],
      default: "list",
    });
    expect(read(undefined, null).layout).toEqual({ allowed: ["list"], default: "list" });
    for (const map of [{ latitude: 91, longitude: 0 }, { latitude: "-8.5", longitude: 115 }, {}])
      expect(read(undefined, map).stays[0]!.map).toBeNull();
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
        rateFilters: {
          breakfast: {
            roomTypesFree: 1,
            price: {
              totalMinor: "23000",
              nightlyMinor: "11500",
              currency: "USD",
              promoApplied: false,
            },
            pricesComplete: true,
          },
          freeCancellation: null,
          // Unreadable: as none.
          both: { roomTypesFree: 1, price: { totalMinor: "1.5" } },
        },
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
          rateFilters: {
            breakfast: {
              roomTypesFree: 1,
              price: { total: 230, nightly: 115, currency: "USD", promoApplied: false },
            },
            freeCancellation: null,
            both: null,
          },
        },
        {
          propertyId: "p2",
          status: "unavailable",
          rooms: 2,
          roomTypesFree: 0,
          price: null,
          nextFree: { checkIn: "2026-11-16", checkOut: "2026-11-18" },
          rateFilters: null,
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
