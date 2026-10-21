import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2247: a hotel can go live before it adds photos. The page draws a calm placeholder instead of
// stretching the Vayada logo over the hero, and its structured data publishes no image.
test.describe("booking-web hotel without photos", () => {
  for (const width of [1280, 390]) {
    test(`shows the hero placeholder and no stand-in logo at ${width}px`, async ({
      page,
    }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);
      await page.setViewportSize({ width, height: 900 });
      await mockBookingApis(page, { noPhotos: true });

      await page.goto("/");

      await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
      await expect(page.getByTestId("hotel-hero-placeholder")).toBeVisible();
      await expect(page.getByRole("img", { name: "Hotel Alpenrose", exact: true })).toHaveCount(0);

      const hotelNode = (await structuredDataGraph(page)).find((node) => node["@type"] === "Hotel");
      expect(hotelNode?.name).toBe("Hotel Alpenrose");
      expect(hotelNode).not.toHaveProperty("image");

      await assertHealthy();
    });
  }
});

async function structuredDataGraph(page: Page): Promise<Array<Record<string, unknown>>> {
  const raw = await page
    .locator('script[type="application/ld+json"]#booking-web-public-structured-data')
    .textContent();
  return (JSON.parse(raw ?? "{}") as { "@graph"?: Array<Record<string, unknown>> })["@graph"] ?? [];
}
