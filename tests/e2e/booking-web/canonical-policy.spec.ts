import { expect, test } from "@playwright/test";

import {
  getCanonicalHostRedirectUrl,
  resolvePublicHotelUrls,
} from "../../../apps/booking-web/lib/server/publicUrls";

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
});
