import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_SETTINGS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminBookingFlow,
  mockBookingAdminDesignSettings,
} from "../support/bookingAdminMocks";

// VAY-2199: every page renders in one shared frame and header, so the title never jumps between
// pages and the title, subtitle and first section are spaced the same everywhere.
const TOP_LEVEL = [
  "/dashboard",
  "/design-studio",
  "/add-ons",
  "/promo-codes",
  "/settings",
  "/settings/feature-hub",
  "/reservations",
  "/affiliates",
];
// Sub-pages put a breadcrumb above the title: same left edge, and one shared (lower) top.
const SUB_PAGES = [
  "/settings/general",
  "/settings/payments",
  "/settings/book-direct-benefits",
  "/settings/room-filters",
  "/settings/guest-form",
  "/settings/location",
];
// Feature Hub's header comes from the shared @vayada/feature-hub page: same title style, its own
// spacing below the header.
const PACKAGE_HEADERS = new Set(["/settings/feature-hub"]);
const SUBTITLE_GAP = 4;
const HEADER_GAP = 24;

// `padding` is the page token at that width. Wider than the 1280px frame, the frame is centred in
// <main>, whose inner width depends on the scrollbar gutter: (1920 - 208 sidebar - gutter - 1280) / 2.
const VIEWPORTS = [
  { width: 1440, height: 900, padding: 24 },
  { width: 1920, height: 1080, padding: 24 },
  { width: 390, height: 844, padding: 16 },
];
const FRAME_MAX_WIDTH = 1280;

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

/** Title style, title → subtitle gap and header → first section gap (null when absent). */
async function headerMetrics(page: Page) {
  return page
    .locator("main h1")
    .first()
    .evaluate((h1) => {
      const style = getComputedStyle(h1);
      const subtitle = h1.nextElementSibling;
      const header = h1.closest(".page-header");
      let section = header?.nextElementSibling ?? null;
      while (
        section &&
        ((section as HTMLElement).offsetHeight === 0 ||
          ["fixed", "absolute"].includes(getComputedStyle(section).position))
      )
        section = section.nextElementSibling;
      const top = (element: Element) => element.getBoundingClientRect().top;
      const bottom = (element: Element) => element.getBoundingClientRect().bottom;
      return {
        font: `${style.fontSize}/${style.fontWeight}`,
        subtitleGap: subtitle?.tagName === "P" ? Math.round(top(subtitle) - bottom(h1)) : null,
        sectionGap: header && section ? Math.round(top(section) - bottom(header)) : null,
      };
    });
}

async function expectHeaderStyle(page: Page, route: string, viewportWidth: number) {
  const { font, subtitleGap, sectionGap } = await headerMetrics(page);
  expect(font, route).toBe(viewportWidth >= 768 ? "24px/600" : "20px/600");
  if (subtitleGap !== null) expect(subtitleGap, `${route} subtitle`).toBe(SUBTITLE_GAP);
  if (!PACKAGE_HEADERS.has(route)) expect(sectionGap, `${route} first section`).toBe(HEADER_GAP);
}

/** Where the frame puts the title: centred within <main>'s inner width, then padded. */
async function expectedTitleX(page: Page, padding: number) {
  const innerWidth = await page.locator("main").evaluate((main) => main.clientWidth);
  return Math.round(Math.max(0, (innerWidth - FRAME_MAX_WIDTH) / 2) + padding);
}

for (const viewport of VIEWPORTS) {
  test(`every page title starts at the same place at ${viewport.width}px`, async ({ page }) => {
    // One test walks every page, so allow for a dev server compiling each route once.
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockPages(page);

    await page.goto(TOP_LEVEL[0]);
    const x = await expectedTitleX(page, viewport.padding);
    // Only 1920 is wide enough for the frame to be centred; narrower screens are just padded.
    expect(x > viewport.padding).toBe(viewport.width === 1920);

    for (const route of TOP_LEVEL) {
      await page.goto(route);
      expect(await titlePosition(page), route).toEqual({ x, y: viewport.padding });
      await expectHeaderStyle(page, route, viewport.width);
    }

    let subPageY: number | undefined;
    for (const route of SUB_PAGES) {
      await page.goto(route);
      const position = await titlePosition(page);
      expect(position.x, route).toBe(x);
      subPageY ??= position.y;
      expect(position.y, route).toBe(subPageY);
      await expectHeaderStyle(page, route, viewport.width);
    }
    expect(subPageY).toBeGreaterThan(viewport.padding);
  });
}

test("the title stays put while clicking through the sidebar", async ({ page }) => {
  test.setTimeout(90_000);
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

test("a save message appears under the header without moving the title", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPages(page);
  await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { detail: "Unavailable" } })
      : route.fallback(),
  );
  await page.goto("/add-ons");
  const before = await titlePosition(page);

  await page.getByRole("switch", { name: /Group by Category/ }).click();
  // The message shows for 3 seconds, right below the header.
  await expect(page.getByText("Failed to update setting", { exact: true })).toBeVisible();
  expect(await titlePosition(page)).toEqual(before);
  expect((await headerMetrics(page)).sectionGap).toBe(HEADER_GAP);
});
