import path from "node:path";
import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";
import { watchPageHealth } from "../support/pageHealth";

const propertyId = "e1943000-0000-4000-8000-000000000003";
test.beforeEach(async ({ page }) => {
  await page.route("https://public-hotel.example.test/**", async (route) => {
    const logo = route.request().url().endsWith("logo.png");
    await route.fulfill({
      path: path.resolve(
        `apps/marketplace-web/public/${logo ? "vayada-logo.png" : "hotel-hero.JPG"}`,
      ),
      contentType: logo ? "image/png" : "image/jpeg",
    });
  });
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ headers: corsHeaders(route), json: null });
  });
});
test("anonymous visitors see the approved profile without writes or simulated collaboration", async ({
  page,
}, info) => {
  const healthy = watchPageHealth(page, info);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && !["GET", "OPTIONS"].includes(request.method()))
      writes.push(request.url());
  });
  let reads = 0;
  await page.route(`**/api/marketplace/hotels/${propertyId}`, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    reads++;
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({
      headers: corsHeaders(route),
      json: {
        propertyId,
        revisionId: "e1943000-0000-4000-8000-000000000005",
        displayName: "Submission Test Hotel",
        propertyType: "hotel",
        shortDescription:
          "A welcoming hotel with comfortable rooms and easy access to local parks and restaurants.",
        locality: { city: "Berlin", countryCode: "DE" },
        media: [
          {
            mediaType: "hero_image",
            url: "https://public-hotel.example.test/hotel.jpg",
            altText: "Hotel exterior",
          },
        ],
      },
    });
  });
  await page.goto(`/hotels/${propertyId}`);
  await expect(page.getByRole("heading", { name: "Submission Test Hotel" })).toBeVisible();
  await expect(page.getByText("Berlin, DE")).toBeVisible();
  await expect(page.getByRole("img", { name: "Hotel exterior" })).toBeVisible();
  await expect(page.getByRole("button", { name: /request collaboration/i })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Submission Test Hotel" })).toBeVisible();
  expect(reads).toBe(2);
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("approved-public-hotel.png"), fullPage: true });
  await healthy();
});
test("an unavailable profile remains unavailable after retry", async ({ page }) => {
  let reads = 0;
  await page.route(`**/api/marketplace/hotels/${propertyId}`, async (route) => {
    reads++;
    await route.fulfill({
      status: 404,
      headers: corsHeaders(route),
      json: { code: "hotel_not_found" },
    });
  });
  await page.goto(`/hotels/${propertyId}`);
  await expect(page.getByRole("heading", { name: "Hotel profile unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByRole("heading", { name: "Hotel profile unavailable" })).toBeVisible();
});
test("provider failure can recover on mobile without revealing private locality", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let failed = true;
  await page.route(`**/api/marketplace/hotels/${propertyId}`, async (route) => {
    await route.fulfill({
      status: failed ? 503 : 200,
      headers: corsHeaders(route),
      json: failed
        ? { code: "public_hotel_unavailable" }
        : {
            propertyId,
            revisionId: "e1943000-0000-4000-8000-000000000005",
            displayName: "Recovered Hotel",
            propertyType: "hotel",
            shortDescription: "An approved public description.",
            locality: null,
            media: [
              {
                mediaType: "logo",
                url: "https://public-hotel.example.test/logo.png",
                altText: "Hotel logo",
              },
            ],
          },
    });
  });
  await page.goto(`/hotels/${propertyId}`);
  await expect(
    page.getByRole("heading", { name: "Hotel details are temporarily unavailable" }),
  ).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Recovered Hotel" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
