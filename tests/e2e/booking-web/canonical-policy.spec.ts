import { expect, test } from "@playwright/test";

import {
  getCanonicalHostRedirectUrl,
  publicHotelPageHreflangUrls,
  publicHotelPageUrl,
  publicHotelSitemapEntries,
  resolvePublicHotelUrls,
} from "../../../apps/booking-web/lib/server/publicUrls";
import {
  privateDisallowRules,
  publicAllowRules,
} from "../../../apps/booking-web/lib/server/crawlRules";

test.describe("booking-web canonical URL policy", () => {
  test("prefers a verified custom domain for canonical public URLs", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      supportedLocales: ["en", "de"],
      customDomainUrl: "https://book.alpenrose.example",
    });

    expect(policy.canonicalUrl).toBe("https://book.alpenrose.example/en");
    expect(policy.bookingBaseUrl).toBe("https://book.alpenrose.example");
    expect(policy.customDomainUrl).toBe("https://book.alpenrose.example");
    expect(policy.jsonLdUrl).toBe(policy.canonicalUrl);
    expect(policy.sitemapUrl).toBe("https://book.alpenrose.example/sitemap.xml");
    expect(policy.hreflangUrls).toEqual({
      en: "https://book.alpenrose.example/en",
      de: "https://book.alpenrose.example/de",
    });
  });

  test("keeps the Vayada fallback domain canonical when no custom domain exists", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      customDomainUrl: null,
    });

    expect(policy.canonicalUrl).toBe("https://hotel-alpenrose.booking.vayada.com/en");
    expect(policy.bookingBaseUrl).toBe("https://hotel-alpenrose.booking.vayada.com");
    expect(policy.customDomainUrl).toBeNull();
  });

  test("redirects fallback hosts to the custom-domain canonical host", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      customDomainUrl: "book.alpenrose.example",
    });

    expect(
      getCanonicalHostRedirectUrl(
        policy,
        new URL("https://hotel-alpenrose.booking.vayada.com/en/rooms?adults=2"),
      ),
    ).toBe("https://book.alpenrose.example/en/rooms?adults=2");
  });

  test("redirects renamed fallback subdomains to the canonical fallback host", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "legacy-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      customDomainUrl: null,
    });

    expect(
      getCanonicalHostRedirectUrl(
        policy,
        new URL("https://legacy-alpenrose.booking.vayada.com/en?ref=creator"),
      ),
    ).toBe("https://hotel-alpenrose.booking.vayada.com/en?ref=creator");
  });

  test("does not redirect when the request host is already canonical", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      customDomainUrl: null,
    });

    expect(
      getCanonicalHostRedirectUrl(policy, new URL("https://hotel-alpenrose.booking.vayada.com/en")),
    ).toBeNull();
  });

  test("does not redirect non-fallback hosts", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.vayada.com",
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
      customDomainUrl: null,
    });

    expect(
      getCanonicalHostRedirectUrl(policy, new URL("https://book.alpenrose.example/en")),
    ).toBeNull();
  });

  test("derives localized room-page URLs from the canonical hotel policy", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.localhost:3002",
      requestProtocol: "http",
      slug: "hotel-alpenrose",
      locale: "en",
      supportedLocales: ["en", "de"],
      customDomainUrl: null,
    });

    expect(publicHotelPageUrl(policy, "/")).toBe(
      "http://hotel-alpenrose.booking.localhost:3002/en",
    );
    expect(publicHotelPageUrl(policy, "/rooms")).toBe(
      "http://hotel-alpenrose.booking.localhost:3002/en/rooms",
    );
    expect(publicHotelPageHreflangUrls(policy, "/rooms")).toEqual({
      en: "http://hotel-alpenrose.booking.localhost:3002/en/rooms",
      de: "http://hotel-alpenrose.booking.localhost:3002/de/rooms",
    });
  });

  test("exposes seeded hotel and room pages through sitemap entries only", () => {
    const policy = resolvePublicHotelUrls({
      requestHost: "hotel-alpenrose.booking.localhost:3002",
      requestProtocol: "http",
      slug: "hotel-alpenrose",
      locale: "en",
      supportedLocales: ["en", "de"],
      customDomainUrl: null,
    });

    expect(publicHotelSitemapEntries(policy)).toEqual([
      {
        url: "http://hotel-alpenrose.booking.localhost:3002/en",
        alternates: {
          en: "http://hotel-alpenrose.booking.localhost:3002/en",
          de: "http://hotel-alpenrose.booking.localhost:3002/de",
        },
      },
      {
        url: "http://hotel-alpenrose.booking.localhost:3002/en/rooms",
        alternates: {
          en: "http://hotel-alpenrose.booking.localhost:3002/en/rooms",
          de: "http://hotel-alpenrose.booking.localhost:3002/de/rooms",
        },
      },
    ]);
  });

  test("allows public hotel routes and excludes private booking flows from robots", () => {
    const locales = ["en", "de"];

    expect(publicAllowRules(locales)).toEqual([
      "/",
      "/rooms",
      "/en",
      "/en/rooms",
      "/de",
      "/de/rooms",
    ]);
    expect(privateDisallowRules(locales)).toEqual(
      expect.arrayContaining([
        "/book",
        "/en/book",
        "/payment",
        "/en/payment",
        "/booking",
        "/en/booking",
        "/booking-status",
        "/en/booking-status",
        "/my-booking",
        "/en/my-booking",
      ]),
    );
    expect(privateDisallowRules(locales)).not.toContain("/rooms");
  });
});
