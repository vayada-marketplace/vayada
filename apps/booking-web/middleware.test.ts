import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import middleware from "./middleware";
import { bookingWebPublicApi } from "./services/api/bookingWebPublic";

vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});
vi.mock("./services/api/bookingWebPublic", () => ({
  bookingWebPublicApi: { resolveHost: vi.fn(), agencyPageStays: vi.fn() },
  PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS: 60,
}));

describe("Booking Web cookies before the privacy choice", () => {
  beforeEach(() => vi.resetAllMocks());

  // VAY-2223: nothing read the old hotel-slug and 30-day ref cookies; none is set any more.
  it("sets no cookie on a hotel page, with or without a referral code", async () => {
    const host = "hotel-alpenrose.next-booking.vayada.com";
    vi.mocked(bookingWebPublicApi.resolveHost).mockResolvedValue({
      slug: "hotel-alpenrose",
      canonicalUrl: `https://${host}/en`,
      bookingBaseUrl: `https://${host}`,
      customDomainUrl: null,
      shouldRedirect: false,
      redirectUrl: null,
      redirectStatus: null,
      hotel: {
        slug: "hotel-alpenrose",
        name: "Hotel Alpenrose",
        defaultLocale: "en",
        supportedLocales: ["en"],
      },
    });
    for (const path of ["/", "/?ref=FRIEND&checkIn=2026-11-12", "/en/book?ref=FRIEND"]) {
      const response = await middleware(
        new NextRequest(`https://${host}${path}`, { headers: { host } }),
      );
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});

describe("Booking Web retired booking pages", () => {
  beforeEach(() => vi.resetAllMocks());

  const host = "hotel-alpenrose.next-booking.vayada.com";

  async function visit(path: string, headers: Record<string, string> = { host }) {
    return middleware(new NextRequest(`https://${host}${path}`, { headers }));
  }

  it("permanently redirects the retired pages to the hotel page, keeping only the stay", async () => {
    const response = await visit(
      "/en/rooms?checkIn=2026-11-12&checkOut=2026-11-14&adults=2&children=1&promoCode=SUMMER20&ref=FRIEND&room=alpine&rateType=flexible",
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://${host}/?checkIn=2026-11-12&checkOut=2026-11-14&adults=2&children=1&promoCode=SUMMER20`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bookingWebPublicApi.resolveHost).not.toHaveBeenCalled();
  });

  it("keeps a non-default locale and accepts unprefixed and trailing-slash paths", async () => {
    expect((await visit("/de/payment")).headers.get("location")).toBe(`https://${host}/de`);
    expect((await visit("/addons/")).headers.get("location")).toBe(`https://${host}/`);
    expect((await visit("/payment?checkIn=")).headers.get("location")).toBe(`https://${host}/`);
  });

  it("redirects on the browser-facing host when the proxy reports an internal origin", async () => {
    const response = await middleware(
      new NextRequest("http://10.0.4.12:3000/fr/addons?checkIn=2026-11-12", {
        headers: { host: "10.0.4.12:3000", "x-forwarded-host": host, "x-forwarded-proto": "http" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://${host}/fr?checkIn=2026-11-12`);
  });

  it("never redirects to a forwarded host Booking does not serve", async () => {
    const response = await middleware(
      new NextRequest(`https://${host}/rooms?checkIn=2026-11-12`, {
        headers: { host, "x-forwarded-host": "attacker.example" },
      }),
    );
    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
    expect(bookingWebPublicApi.resolveHost).toHaveBeenCalledWith("attacker.example", {
      next: { revalidate: 60 },
    });
  });

  it("redirects on a hotel's resolved custom domain", async () => {
    vi.mocked(bookingWebPublicApi.resolveHost).mockResolvedValue({
      slug: "hotel-alpenrose",
      canonicalUrl: "https://book.alpenrose.example/en",
      bookingBaseUrl: "https://book.alpenrose.example",
      customDomainUrl: "https://book.alpenrose.example",
      shouldRedirect: false,
      redirectUrl: null,
      redirectStatus: null,
      hotel: {
        slug: "hotel-alpenrose",
        name: "Hotel Alpenrose",
        defaultLocale: "en",
        supportedLocales: ["en"],
      },
    });
    const response = await middleware(
      new NextRequest("https://book.alpenrose.example/payment", {
        headers: { host: "book.alpenrose.example" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://book.alpenrose.example/");
  });

  it("leaves other pages and unknown locales alone", async () => {
    for (const path of ["/en/book", "/en/roomsx", "/xx/rooms", "/en/rooms/alpine", "/"]) {
      const response = await visit(path);
      expect(response.status, path).not.toBe(308);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});

describe("Booking Web former hotel addresses (VAY-2295)", () => {
  beforeEach(() => vi.resetAllMocks());

  function resolvesTo(slug: string) {
    vi.mocked(bookingWebPublicApi.resolveHost).mockResolvedValue({
      slug,
      canonicalUrl: `https://${slug}.next-booking.vayada.com/en`,
      bookingBaseUrl: `https://${slug}.next-booking.vayada.com`,
      customDomainUrl: null,
      shouldRedirect: false,
      redirectUrl: null,
      redirectStatus: null,
      hotel: { slug, name: "Hotel Alpenrose", defaultLocale: "en", supportedLocales: ["en", "de"] },
    });
  }

  it("permanently redirects a former address to the hotel's current one, keeping path and query", async () => {
    resolvesTo("alpenrose-lodge");
    const response = await middleware(
      new NextRequest(
        "https://hotel-alpenrose.next-booking.vayada.com/de/book?checkIn=2026-11-12",
        {
          headers: { host: "hotel-alpenrose.next-booking.vayada.com" },
        },
      ),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://alpenrose-lodge.next-booking.vayada.com/de/book?checkIn=2026-11-12",
    );
  });

  it("serves the current address in place", async () => {
    resolvesTo("alpenrose-lodge");
    const response = await middleware(
      new NextRequest("https://alpenrose-lodge.next-booking.vayada.com/de/book", {
        headers: { host: "alpenrose-lodge.next-booking.vayada.com" },
      }),
    );
    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});

// VAY-2462: a stay's pages (its page, checkout and bookings) are only on an agency's address, for
// the stays its live page shows; a page load anywhere else answers 404.
describe("Booking Web stay pages on an agency's address", () => {
  beforeEach(() => vi.resetAllMocks());

  const agency = "the-travel-ubud.next-booking.vayada.com";
  const hotel = "hotel-alpenrose.next-booking.vayada.com";
  const load = (host: string, path: string, headers: Record<string, string> = {}) =>
    middleware(new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } }));

  it("serves the stays the agency's live page shows, and answers 404 for others", async () => {
    vi.mocked(bookingWebPublicApi.agencyPageStays).mockResolvedValue([
      "escape-ubud",
      "mertha-ubud",
    ]);
    for (const path of [
      "/stays/escape-ubud?checkIn=2026-12-01",
      "/de/stays/mertha-ubud/book?offer=x",
      "/stays/escape-ubud/booking/VAY-ABC123",
    ])
      expect((await load(agency, path)).status, path).not.toBe(404);
    expect(bookingWebPublicApi.agencyPageStays).toHaveBeenCalledWith(
      "the-travel-ubud",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const response = await load(agency, "/stays/other-hotel/book?offer=x");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const html = await response.text();
    expect(html).toContain("This booking page isn&#39;t online right now");
    expect(html).toContain('<meta name="robots" content="noindex">');
    // In the address's language.
    expect(await (await load(agency, "/de/stays/other-hotel")).text()).toContain(
      "Diese Buchungsseite ist gerade nicht online",
    );
  });

  it("answers 404 for stay pages on a hotel's address", async () => {
    vi.mocked(bookingWebPublicApi.agencyPageStays).mockResolvedValue(null);
    expect((await load(hotel, "/stays/escape-ubud")).status).toBe(404);
    expect(bookingWebPublicApi.agencyPageStays).toHaveBeenCalledWith(
      "hotel-alpenrose",
      expect.anything(),
    );
  });

  it("leaves it to the page when the agency page can't be read, and for the app's own navigation", async () => {
    vi.mocked(bookingWebPublicApi.agencyPageStays).mockRejectedValue(new Error("unreachable"));
    expect((await load(agency, "/stays/other-hotel")).status).not.toBe(404);
    vi.mocked(bookingWebPublicApi.agencyPageStays).mockClear();
    const navigations: Record<string, string>[] = [
      { rsc: "1" },
      { "next-router-prefetch": "1", rsc: "1" },
    ];
    for (const headers of navigations)
      expect((await load(agency, "/stays/other-hotel", headers)).status).not.toBe(404);
    expect(bookingWebPublicApi.agencyPageStays).not.toHaveBeenCalled();
  });

  it("asks nothing for other pages or on a development host", async () => {
    for (const path of ["/", "/de", "/book?offer=x", "/booking/VAY-ABC123", "/staying"])
      expect((await load(agency, path)).status, path).not.toBe(404);
    await middleware(
      new NextRequest("http://localhost:3002/stays/other-hotel", {
        headers: { host: "localhost:3002" },
      }),
    );
    expect(bookingWebPublicApi.agencyPageStays).not.toHaveBeenCalled();
  });
});
