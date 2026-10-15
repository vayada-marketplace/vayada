import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminBookingFlow,
  mockBookingAdminDesignSettings,
} from "../support/bookingAdminMocks";

// VAY-2199: every page renders in one shared frame, so the title never jumps between pages.
const TOP_LEVEL = ["/dashboard", "/design-studio", "/add-ons", "/promo-codes", "/settings"];
// Sub-pages put a breadcrumb above the title: same left edge, and one shared (lower) top.
const SUB_PAGES = [
  "/settings/general",
  "/settings/payments",
  "/settings/book-direct-benefits",
  "/settings/location",
];

const VIEWPORTS = [
  { width: 1440, height: 900, x: 24, y: 24 },
  // Wider than the 1280px frame: centred, (1920 - 208 sidebar - 1280) / 2 + 24.
  { width: 1920, height: 1080, x: 240, y: 24 },
  { width: 390, height: 844, x: 16, y: 16 },
];

async function mockPages(page: Page) {
  await mockBookingAdminBookingFlow(page);
  await mockBookingAdminDesignSettings(page);
  // Location & surroundings: an empty curation, no suggestions provider and no Maps script.
  const nearby = `/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/nearby`;
  await page.route(`**${nearby}/curation`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        profileRevision: 1,
        curationRevision: 0,
        savedProfileRevision: null,
        choices: [],
        customPlaces: [],
      },
    }),
  );
  await page.route(`**${nearby}/refresh`, (route) =>
    route.fulfill({ status: 503, json: { code: "not_configured" } }),
  );
  await page.route("https://maps.googleapis.com/**", (route) => route.abort());
}

/** The page title's position inside <main>, in whole pixels. */
async function titlePosition(page: Page) {
  const title = page.locator("main h1").first();
  await expect(title).toBeVisible();
  return title.evaluate((h1) => {
    const main = h1.closest("main")!.getBoundingClientRect();
    const box = h1.getBoundingClientRect();
    return { x: Math.round(box.x - main.x), y: Math.round(box.y - main.y) };
  });
}

for (const viewport of VIEWPORTS) {
  test(`every page title starts at the same place at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockPages(page);

    for (const route of TOP_LEVEL) {
      await page.goto(route);
      expect(await titlePosition(page), route).toEqual({ x: viewport.x, y: viewport.y });
    }

    let subPageY: number | undefined;
    for (const route of SUB_PAGES) {
      await page.goto(route);
      const { x, y } = await titlePosition(page);
      expect(x, route).toBe(viewport.x);
      subPageY ??= y;
      expect(y, route).toBe(subPageY);
    }
    expect(subPageY).toBeGreaterThan(viewport.y);
  });
}

test("the title stays put while clicking through the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPages(page);
  await page.goto("/dashboard");
  const title = page.locator("main h1").first();
  const start = await titlePosition(page);

  for (const [label, path] of [
    ["Add-ons", /\/add-ons$/],
    ["Promos", /\/promo-codes$/],
    ["Settings", /\/settings$/],
    ["Design Studio", /\/design-studio$/],
    ["Dashboard", /\/dashboard$/],
  ] as const) {
    const previous = await title.innerText();
    await page.getByRole("navigation").getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(path);
    await expect(title).not.toHaveText(previous);
    expect(await titlePosition(page), label).toEqual(start);
  }
});
