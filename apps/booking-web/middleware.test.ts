import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import middleware, { config } from "./middleware";
import { bookingWebPublicApi } from "./services/api/bookingWebPublic";

vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});
vi.mock("./services/api/bookingWebPublic", () => ({
  bookingWebPublicApi: { resolveHost: vi.fn() },
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

  it("permanently redirects the retired pages to /book, keeping only what /book reads and the referral", async () => {
    const response = await visit(
      "/en/rooms?checkIn=2026-11-12&checkOut=2026-11-14&adults=2&children=1&promoCode=SUMMER20&ref=FRIEND&room=alpine&rateType=flexible",
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://${host}/book?checkIn=2026-11-12&checkOut=2026-11-14&adults=2&children=1&promoCode=SUMMER20&ref=FRIEND`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bookingWebPublicApi.resolveHost).not.toHaveBeenCalled();
  });

  it("keeps a non-default locale and accepts unprefixed and trailing-slash paths", async () => {
    expect((await visit("/de/payment")).headers.get("location")).toBe(`https://${host}/de/book`);
    expect((await visit("/addons/")).headers.get("location")).toBe(`https://${host}/book`);
    expect((await visit("/payment?checkIn=")).headers.get("location")).toBe(`https://${host}/book`);
  });

  it("redirects on the browser-facing host when the proxy reports an internal origin", async () => {
    const response = await middleware(
      new NextRequest("http://10.0.4.12:3000/fr/addons?checkIn=2026-11-12", {
        headers: { host: "10.0.4.12:3000", "x-forwarded-host": host, "x-forwarded-proto": "http" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://${host}/fr/book?checkIn=2026-11-12`);
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
    expect(response.headers.get("location")).toBe("https://book.alpenrose.example/book");
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
      new NextRequest("https://hotel-alpenrose.next-booking.vayada.com/de/book?checkIn=2026-11-12", {
        headers: { host: "hotel-alpenrose.next-booking.vayada.com" },
      }),
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
