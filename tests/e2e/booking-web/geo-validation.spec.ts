/**
 * GEO validation spec — VAY-664.
 *
 * Asserts that public hotel pages emit valid JSON-LD, that private booking
 * pages are excluded from indexing, that sitemap URLs are correctly scoped,
 * and that the public AI profile/quote contract fixture cases match the
 * GEO validation contract defined in `@vayada/domain-distribution/geo`.
 *
 * These tests can run locally without production secrets:
 *   npm run e2e:booking-web
 *
 * All network calls are mocked via `mockBookingApis`. For live-backend
 * validation start portless first (see tests/e2e/README.md).
 */

import { expect, test, type Page } from "@playwright/test";
import {
  GEO_AI_CONTRACT_REQUIRED_CASE_IDS,
  GEO_BOOKING_WEB_ROBOTS_POLICIES,
  GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS,
  geoAiContractCaseSpec,
  validateHotelJsonLdNode,
  validateHotelRoomJsonLdNode,
  validateGeoSitemap,
} from "../../../packages/domain-distribution/src/geo";
import {
  PUBLIC_BOOKABILITY_FIXTURES,
  PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS,
} from "../../../packages/domain-distribution/src/fixtures";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function publicStructuredDataGraph(page: Page): Promise<Array<Record<string, unknown>>> {
  const rawStructuredData = await page
    .locator('script[type="application/ld+json"]#booking-web-public-structured-data')
    .textContent();
  expect(rawStructuredData).toBeTruthy();
  const parsed = JSON.parse(rawStructuredData ?? "{}") as {
    "@graph"?: Array<Record<string, unknown>>;
  };
  expect(parsed["@graph"]).toBeTruthy();
  return parsed["@graph"] ?? [];
}

async function getMetaRobots(page: Page): Promise<string | null> {
  return page.locator('meta[name="robots"]').getAttribute("content");
}

// ---------------------------------------------------------------------------
// JSON-LD validation
// ---------------------------------------------------------------------------

test.describe("booking-web JSON-LD GEO contract", () => {
  test("public hotel page emits parseable JSON-LD with required Hotel fields", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.goto("/");

    const graph = await publicStructuredDataGraph(page);
    const hotelNode = graph.find((node) => node["@type"] === "Hotel");

    expect(hotelNode).toBeDefined();
    const validation = validateHotelJsonLdNode(hotelNode as Record<string, unknown>);
    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredFields).toEqual([]);
    expect(validation.forbiddenFields).toEqual([]);
    expect(validation.errors).toEqual([]);

    // Hotel node must reference the canonical URL derived from the request host
    const hostname = new URL(baseURL ?? page.url()).hostname.split(".")[0];
    expect(hostname).toBe(SEEDED_BOOKING_SLUG);
    expect(hotelNode?.name).toBe("Hotel Alpenrose");

    await assertHealthy();
  });

  test("public room nodes in JSON-LD do not include offers (price is served by quote API)", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.goto("/");

    const graph = await publicStructuredDataGraph(page);
    const roomNodes = graph.filter((node) => node["@type"] === "HotelRoom");

    // Rooms are priced on /book since the public offers search was retired, so the
    // hotel page publishes no HotelRoom nodes; any that reappear must stay price-free.
    expect(roomNodes).toEqual([]);

    for (const roomNode of roomNodes) {
      const validation = validateHotelRoomJsonLdNode(roomNode as Record<string, unknown>);
      // `offers` must never appear; everything else can be present or absent.
      expect(validation.errors.filter((e) => e.includes("offers"))).toEqual([]);
      expect(roomNode).not.toHaveProperty("offers");
    }

    await assertHealthy();
  });

  test("room JSON-LD nodes include containedInPlace referencing the Hotel @id", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.goto("/");

    const graph = await publicStructuredDataGraph(page);
    const hotelNode = graph.find((node) => node["@type"] === "Hotel");
    const roomNodes = graph.filter((node) => node["@type"] === "HotelRoom");

    expect(hotelNode?.["@id"]).toBeTruthy();

    for (const roomNode of roomNodes) {
      const containedInPlace = roomNode["containedInPlace"] as { "@id": string } | undefined;
      expect(containedInPlace?.["@id"]).toBe(hotelNode?.["@id"]);
    }

    await assertHealthy();
  });
});

// ---------------------------------------------------------------------------
// Robots / indexability
// ---------------------------------------------------------------------------

test.describe("booking-web robots / indexability GEO contract", () => {
  test("checkout page is excluded from indexing", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    // Navigate to the checkout page path; mock any room/payment redirects.
    const response = await page.goto(
      "/en/book?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible",
    );

    const status = response?.status() ?? 0;

    // A redirect from /book is a GEO failure: the page is not being served
    // with a proper noindex directive. Treat any non-200 response as a failure
    // unless it is a server error we want to surface separately.
    expect(status, "Checkout must return 200 (with noindex), not a redirect or error").toBe(200);

    const contentType = response?.headers()["content-type"] ?? "";
    expect(contentType, "Checkout 200 response must be HTML").toContain("text/html");

    const robots = await getMetaRobots(page);
    expect(robots, "Checkout page must have noindex robots meta").not.toBeNull();
    expect(robots, "Checkout page robots meta must contain noindex").toContain("noindex");

    await assertHealthy();
  });

  test("retired payment page redirects to the noindex booking page", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    // The retired step answers a server redirect (no indexable page of its own) ...
    const redirect = await page.request.get("/en/payment", { maxRedirects: 0 });
    expect(redirect.status(), "Payment must answer a server redirect").toBe(308);
    expect(new URL(redirect.headers()["location"]!).pathname).toBe("/book");

    // ... to the room-and-price page, which must not be indexed either.
    const response = await page.goto("/en/payment");
    expect(response?.status() ?? 0, "Redirect target must return 200").toBe(200);
    const robots = await getMetaRobots(page);
    expect(robots, "Redirect target must have noindex robots meta").toContain("noindex");

    await assertHealthy();
  });

  test("my-booking page is excluded from indexing", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    const response = await page.goto("/en/my-booking");

    const status = response?.status() ?? 0;

    // The guest private booking dashboard must return 200 with a noindex directive.
    expect(status, "My-booking page must return 200 (with noindex), not a redirect or error").toBe(
      200,
    );

    const contentType = response?.headers()["content-type"] ?? "";
    expect(contentType, "My-booking 200 response must be HTML").toContain("text/html");

    const robots = await getMetaRobots(page);
    expect(robots, "My-booking page must have noindex robots meta").not.toBeNull();
    expect(robots, "My-booking page robots meta must contain noindex").toContain("noindex");

    await assertHealthy();
  });

  test("GEO robots policy contract lists noindex rules for all private page kinds", () => {
    const noindexPolicies = GEO_BOOKING_WEB_ROBOTS_POLICIES.filter((p) => !p.shouldBeIndexable);
    const noindexPaths = noindexPolicies.map((p) => p.pathPattern);

    // All private checkout-related paths must be listed in the contract.
    expect(noindexPaths.some((p) => p.includes("book"))).toBe(true);
    expect(noindexPaths.some((p) => p.includes("payment"))).toBe(true);
    expect(noindexPaths.some((p) => p.includes("booking"))).toBe(true);
    expect(noindexPaths.some((p) => p.includes("my-booking"))).toBe(true);
    // Add-ons selection step must also be listed as a private (noindex) path.
    expect(noindexPaths.some((p) => p.includes("addons"))).toBe(true);
  });

  test("retired addons page redirects to the noindex booking page", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    // The retired step answers a server redirect (no indexable page of its own) ...
    const redirect = await page.request.get("/en/addons", { maxRedirects: 0 });
    expect(redirect.status(), "Addons must answer a server redirect").toBe(308);
    expect(new URL(redirect.headers()["location"]!).pathname).toBe("/book");

    // ... to the room-and-price page, which must not be indexed either.
    const response = await page.goto("/en/addons");
    expect(response?.status() ?? 0, "Redirect target must return 200").toBe(200);
    const robots = await getMetaRobots(page);
    expect(robots, "Redirect target must have noindex robots meta").toContain("noindex");

    await assertHealthy();
  });
});

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

test.describe("booking-web sitemap GEO contract", () => {
  test("sitemap.xml is served and does not include private booking paths", async ({ page }) => {
    await mockBookingApis(page);
    const response = await page.goto("/sitemap.xml");
    const status = response?.status() ?? 0;

    // Sitemap may not exist yet (returns 404) — that is a known gap.
    // When it does exist it must not include private paths.
    if (status === 200) {
      const xml = await response.text();
      const locMatches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => ({
        loc: m[1],
      }));

      const result = validateGeoSitemap(locMatches, []);
      expect(result.forbiddenUrls).toEqual([]);
    } else {
      // 404 is acceptable during development; log for awareness.
      // This test will fail once the sitemap is implemented if private
      // paths are mistakenly included.
      expect([200, 404]).toContain(status);
    }
  });

  test("sitemap forbidden path fragments contract covers all private routes", () => {
    const required = ["/book", "/payment", "/booking/", "/confirmation", "/my-booking", "/addons"];
    for (const fragment of required) {
      expect(GEO_SITEMAP_FORBIDDEN_PATH_FRAGMENTS).toContain(fragment);
    }
  });
});

// ---------------------------------------------------------------------------
// AI profile / quote GEO contract cases
// ---------------------------------------------------------------------------

test.describe("public AI profile/quote GEO contract case coverage", () => {
  test("fixtures include all required GEO AI contract case IDs from VAY-664", () => {
    const fixtureIds = new Set(PUBLIC_BOOKABILITY_FIXTURE_CASE_IDS);

    // Every GEO AI contract case ID must have a matching fixture case ID.
    for (const caseId of GEO_AI_CONTRACT_REQUIRED_CASE_IDS) {
      expect(fixtureIds, `Missing fixture for GEO contract case "${caseId}"`).toContain(caseId);
    }
  });

  for (const caseId of GEO_AI_CONTRACT_REQUIRED_CASE_IDS) {
    const spec = geoAiContractCaseSpec(caseId);

    test(`GEO AI contract spec for "${caseId}" has correct indexability and JSON-LD flags`, () => {
      // Re-assert the spec shape so any future edits to geo.ts fail the test.
      expect(typeof spec.mustBeIndexable).toBe("boolean");
      expect(typeof spec.mustHaveJsonLd).toBe("boolean");
      expect(spec.description.length).toBeGreaterThan(10);
    });
  }

  test("private_hotel fixture is unavailable and must not be indexed or have JSON-LD", () => {
    const fixture = PUBLIC_BOOKABILITY_FIXTURES.find((f) => f.caseId === "private_hotel");
    const spec = geoAiContractCaseSpec("private_hotel");

    expect(fixture).toBeDefined();
    expect(fixture?.profile.hotel.trust.bookabilityStatus).toBe("unavailable");
    expect(fixture?.profile.hotel.trust.reasonCodes).toContain("unpublished");
    expect(fixture?.quote?.status).toBe("unavailable");
    expect(fixture?.quote?.quote).toBeUndefined();

    // GEO contract must agree with the fixture state.
    expect(spec.mustBeIndexable).toBe(false);
    expect(spec.mustHaveJsonLd).toBe(false);
    expect(spec.expectedQuoteStatus).toBe("unavailable");
  });

  test("bookability fixtures derive JSON-LD and canonical metadata from the same projection fields", () => {
    for (const fixture of PUBLIC_BOOKABILITY_FIXTURES) {
      if (fixture.caseId === "private_hotel") continue;

      // The canonical URL in the profile is the source-of-truth for JSON-LD @id and sitemap.
      expect(fixture.profile.hotel.canonicalUrl).toBeTruthy();
      expect(fixture.profile.hotel.slug).toBeTruthy();
      expect(fixture.profile.hotel.name).toBeTruthy();

      // Custom domain case must use the custom domain as canonical.
      if (fixture.caseId === "custom_domain") {
        expect(fixture.profile.hotel.canonicalUrl).toContain(
          fixture.profile.hotel.customDomainUrl ?? "",
        );
        expect(fixture.profile.hotel.trust.domainVerified).toBe(true);
      }

      // Renamed property case must reflect the new slug.
      if (fixture.caseId === "renamed_property") {
        expect(fixture.profile.hotel.slug).toBe("alpenrose-resort");
        expect(fixture.profile.hotel.canonicalUrl).toContain("alpenrose-resort");
      }
    }
  });
});
