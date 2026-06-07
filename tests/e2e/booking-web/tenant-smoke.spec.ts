import { expect, test, type Page } from "@playwright/test";
import publicBookabilityCases from "../../../engineering/fixtures/public-bookability/cases.json";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-web tenant smoke", () => {
  test("renders the seeded tenant from the request host", async ({ page, baseURL }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto("/");

    expect(new URL(baseURL ?? page.url()).hostname.split(".")[0]).toBe(SEEDED_BOOKING_SLUG);
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Check Availability/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Available Accommodations/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite")).toBeVisible();
    await expect(page.getByRole("button", { name: /Select This Rate/i }).first()).toBeVisible();

    const graph = await publicStructuredDataGraph(page);
    const hotelNode = graph.find((node) => node["@type"] === "Hotel");
    expect(hotelNode).toMatchObject({
      "@type": "Hotel",
      name: "Hotel Alpenrose",
      url: "http://hotel-alpenrose.booking.localhost:3002/en",
      checkinTime: "15:00",
      checkoutTime: "11:00",
    });
    expect(hotelNode?.image).toContain(
      "http://hotel-alpenrose.booking.localhost:3002/vayada-logo.png",
    );

    const availableRoom = graph.find(
      (node) => node["@type"] === "HotelRoom" && node.name === "Alpine Suite",
    );
    expect(availableRoom).toMatchObject({
      "@type": "HotelRoom",
      name: "Alpine Suite",
      containedInPlace: { "@id": "http://hotel-alpenrose.booking.localhost:3002/en#hotel" },
    });
    expect(availableRoom?.offers).toBeUndefined();

    const unavailableRoom = graph.find(
      (node) => node["@type"] === "HotelRoom" && node.name === "Garden Room",
    );
    expect(unavailableRoom).toBeTruthy();
    expect(unavailableRoom?.offers).toBeUndefined();

    const quoteUnavailableCases = publicBookabilityCases.cases
      .filter((fixture) => fixture.expected.offerCount === 0)
      .map((fixture) => fixture.caseId);
    expect(quoteUnavailableCases).toEqual(
      expect.arrayContaining(["sold-out", "payment-disabled", "min-stay-not-met"]),
    );
    expect(
      graph.filter((node) => node["@type"] === "HotelRoom").every((node) => !node.offers),
    ).toBe(true);

    await assertHealthy();
  });
});

type JsonLdNode = {
  "@type"?: string;
  name?: string;
  url?: string;
  image?: string[];
  checkinTime?: string;
  checkoutTime?: string;
  containedInPlace?: { "@id": string };
  offers?: {
    "@type": string;
    price: number;
    priceCurrency: string;
    availability: string;
  };
};

async function publicStructuredDataGraph(page: Page) {
  const rawStructuredData = await page
    .locator('script[type="application/ld+json"]#booking-web-public-structured-data')
    .textContent();
  expect(rawStructuredData).toBeTruthy();
  const structuredData = JSON.parse(rawStructuredData ?? "{}") as { "@graph"?: JsonLdNode[] };
  expect(structuredData["@graph"]).toBeTruthy();
  return structuredData["@graph"] ?? [];
}
