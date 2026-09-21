import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("Booking Web affiliate reference prelaunch guard", () => {
  beforeEach(() => vi.resetAllMocks());

  it("covers the approved native root destination and booking pages", () => {
    const matcher = new RegExp(`^${config.matcher}$`);
    expect(matcher.test("/")).toBe(true);
    expect(matcher.test("/en/rooms")).toBe(true);
    expect(matcher.test("/api/booking-web/accept")).toBe(false);
    expect(matcher.test("/en/file.pdf")).toBe(false);
  });

  it("strips every opaque reference on the same host before rendering or host resolution", async () => {
    const response = await middleware(
      new NextRequest(
        "https://old.next-booking.vayada.com/de?vref=vc_first&checkIn=2026-10-01&vref=vc_second&ref=legacy",
        { headers: { host: "old.next-booking.vayada.com" } },
      ),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://old.next-booking.vayada.com/de?checkIn=2026-10-01&ref=legacy",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(bookingWebPublicApi.resolveHost).not.toHaveBeenCalled();
  });

  it("clears a sole or empty reference without changing host", async () => {
    for (const query of ["?vref=vc_token", "?vref="]) {
      const response = await middleware(
        new NextRequest(`https://old.next-booking.vayada.com/en${query}`),
      );
      expect(response.headers.get("location")).toBe("https://old.next-booking.vayada.com/en");
      expect(response.status).toBe(307);
    }
  });

  it("uses the public host when the proxy's internal origin differs", async () => {
    const response = await middleware(
      new NextRequest("http://internal-proxy:3000/en?vref=vc_token&checkIn=2026-10-01", {
        headers: {
          host: "internal-proxy:3000",
          "x-forwarded-host": "hotel-alpenrose.next-booking.vayada.com",
          "x-forwarded-proto": "https",
        },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com/en?checkIn=2026-10-01",
    );
    expect(bookingWebPublicApi.resolveHost).not.toHaveBeenCalled();
  });

  it("never downgrades a public Booking host even if a proxy reports HTTP", async () => {
    const response = await middleware(
      new NextRequest("http://internal-proxy:3000/en?vref=vc_token", {
        headers: {
          host: "internal-proxy:3000",
          "x-forwarded-host": "hotel-alpenrose.next-booking.vayada.com",
          "x-forwarded-proto": "http",
        },
      }),
    );
    expect(response.headers.get("location")).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com/en",
    );
  });

  it("rejects an unrecognized or loopback-prefix-spoofed forwarded host", async () => {
    for (const forwardedHost of ["attacker.example", "127.0.0.1.attacker.example", "localhost:8080"]) {
      const response = await middleware(
        new NextRequest("https://hotel-alpenrose.next-booking.vayada.com/en?vref=vc_token", {
          headers: {
            host: "hotel-alpenrose.next-booking.vayada.com",
            "x-forwarded-host": forwardedHost,
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (forwardedHost !== "localhost:8080")
        expect(bookingWebPublicApi.resolveHost).toHaveBeenCalledWith(forwardedHost, {
          next: { revalidate: 60 },
        });
    }
  });

  it("canonicalizes only the cleaned follow-up request", async () => {
    vi.mocked(bookingWebPublicApi.resolveHost).mockResolvedValue({
      slug: "hotel-alpenrose",
      canonicalUrl: "https://hotel.example/de",
      bookingBaseUrl: "https://hotel.example",
      customDomainUrl: "https://hotel.example",
      shouldRedirect: true,
      redirectUrl: "https://hotel.example/de",
      redirectStatus: 308,
      hotel: {
        slug: "hotel-alpenrose",
        name: "Hotel Alpenrose",
        defaultLocale: "en",
        supportedLocales: ["en", "de"],
      },
    });
    const response = await middleware(
      new NextRequest("https://old.next-booking.vayada.com/de?checkIn=2026-10-01", {
        headers: { host: "old.next-booking.vayada.com" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://hotel.example/de?checkIn=2026-10-01");
    expect(bookingWebPublicApi.resolveHost).toHaveBeenCalledOnce();
  });
});
