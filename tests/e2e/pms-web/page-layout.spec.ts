import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { checkinSettingsResponse } from "../support/checkinSettingsMocks";

// VAY-2204: every PMS page puts its title in the same place: 24px in from <main>'s left and top
// edges (16px on phones), at every screen width, so the title never jumps between pages. Pages
// with a narrower reading column keep their width but start at that same left edge.
// Calendar and Inbox are full-height app views with their own toolbars and are not listed.
const TOP_LEVEL = [
  "/dashboard",
  "/bookings",
  "/rooms",
  "/channel-manager",
  "/financials",
  "/reviews",
  "/settings",
];
// Settings sub-pages (one per card, VAY-2275) put a breadcrumb line above the title: same left
// edge, one shared lower top.
const SUB_PAGES = [
  "/settings/feature-hub",
  "/settings/property",
  "/settings/calendar",
  "/settings/check-in",
  "/settings/guest-flows",
  "/settings/ota-commissions",
  "/settings/team",
  "/settings/billing",
];
// Detail pages open with a back link or guest details before the title, so their title sits a
// little further in, but never moves with the screen width.
const DETAIL_PAGES = [
  `/bookings/${PMS_WEB_RESERVATION_ID}`,
  `/check-in/${PMS_WEB_RESERVATION_ID}`,
  `/check-out/${PMS_WEB_RESERVATION_ID}`,
];

const VIEWPORTS = [
  { width: 1440, height: 900, padding: 24 },
  { width: 1920, height: 1080, padding: 24 },
  { width: 390, height: 844, padding: 16 },
];

async function mockPages(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const reservation = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  // Check-out only shows its workspace for a guest who has checked in.
  const checkedIn = {
    ...pmsWebReservation,
    status: "checked_in",
    checkin: { completedAt: "2026-08-15T14:00:00.000Z", pendingFlags: [] },
  };
  await page.route(reservation, (route) =>
    route.fulfill({
      json: { item: page.url().includes("/check-out/") ? checkedIn : pmsWebReservation },
    }),
  );
  await page.route(`${reservation}/notes`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${reservation}/additional-guests`, (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route(`${reservation}/change-request`, (route) => route.fulfill({ json: null }));
  const property = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}`;
  await page.route(`${property}/check-in-settings`, (route) =>
    route.fulfill({ json: checkinSettingsResponse() }),
  );
  await page.route(`${property}/check-in-checklist`, (route) =>
    route.fulfill({ json: { template: { steps: [], updatedAt: null, updatedByUserId: null } } }),
  );
  await page.route(`${property}/manual-bookings/addons`, (route) =>
    route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: [] } }),
  );
}

/** True on the route's own URL, so a redirect elsewhere can't pass for it. */
function onRoute(route: string) {
  return (url: URL) => url.pathname === route;
}

/** The page title's position inside <main>, in whole pixels. */
async function titlePosition(page: Page) {
  const title = page.locator("main h1").first();
  await expect(title).toBeVisible();
  return title.evaluate((h1) => {
    const main = h1.closest("main")!;
    const frame = main.getBoundingClientRect();
    const box = h1.getBoundingClientRect();
    return { x: Math.round(box.x - frame.x), y: Math.round(box.y - frame.y + main.scrollTop) };
  });
}

for (const viewport of VIEWPORTS) {
  test(`every page title starts at the same place at ${viewport.width}px`, async ({ page }) => {
    // One test walks every page, so allow for a dev server compiling each route once.
    test.setTimeout(240_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockPages(page);

    for (const route of TOP_LEVEL) {
      await page.goto(route);
      const position = await titlePosition(page);
      // Checked after the title shows, so a client-side redirect can't pass for the page.
      await expect(page).toHaveURL(onRoute(route));
      expect(position, route).toEqual({ x: viewport.padding, y: viewport.padding });
    }

    let subPageY: number | undefined;
    for (const route of SUB_PAGES) {
      await page.goto(route);
      const position = await titlePosition(page);
      await expect(page).toHaveURL(onRoute(route));
      expect(position.x, route).toBe(viewport.padding);
      subPageY ??= position.y;
      expect(position.y, route).toBe(subPageY);
    }
    expect(subPageY).toBeGreaterThan(viewport.padding);
  });
}

test("detail page titles stay at the left edge on wide screens", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPages(page);
  for (const route of DETAIL_PAGES) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route);
    const narrow = await titlePosition(page);
    await expect(page).toHaveURL(onRoute(route));
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect(await titlePosition(page), route).toEqual(narrow);
    // A back link or button may come first, but a centred column would start far further in.
    expect(narrow.x, route).toBeLessThan(120);
  }
});

test("the title stays put while clicking through the sidebar", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPages(page);
  await page.goto("/dashboard");
  const title = page.locator("main h1").first();
  const start = await titlePosition(page);
  const sidebar = page.getByRole("navigation").first();

  for (const [label, path] of [
    ["Reservations", /\/bookings$/],
    ["Reviews", /\/reviews$/],
    ["Financials", /\/financials$/],
    ["Rooms & Rates", /\/rooms$/],
    ["Settings", /\/settings$/],
    ["Dashboard", /\/dashboard$/],
  ] as const) {
    const previous = await title.innerText();
    await sidebar.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(path);
    await expect(title).not.toHaveText(previous);
    expect(await titlePosition(page), label).toEqual(start);
  }
});
