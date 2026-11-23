import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const STATS_ROUTE = "**/api/booking/properties/*/dashboard/stats**";
const money = (amountDecimal: string, currency = "EUR") => ({ amountDecimal, currency });

function stats(revenue: string, bookingCount: number, pageViewCount: number, currency = "EUR") {
  const zero = { totalRevenue: money("0.00"), bookingCount: 0, avgNightlyRate: money("0.00") };
  return {
    metrics: {
      current: {
        totalRevenue: money(revenue, currency),
        bookingCount,
        avgNightlyRate: money("120.00", currency),
        pageViewCount,
      },
      previous: { ...zero, pageViewCount: 0 },
      nextArrivalDate: null,
      liveSinceDate: null,
    },
  };
}

// The header strip, named after the Dashboard's range: the last 30 days until another is picked.
const strip = (page: Page, range = "Last 30 days") =>
  page.locator("header").getByRole("link", { name: new RegExp(`^${range}`) });
const days = (url: URL) =>
  (Date.parse(`${url.searchParams.get("periodEnd")}T00:00:00Z`) -
    Date.parse(`${url.searchParams.get("periodStart")}T00:00:00Z`)) /
    86_400_000 +
  1;

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("shows the Dashboard's last 30 days next to the property and opens the Dashboard (VAY-2203)", async ({
  page,
}, testInfo) => {
  const reads: URL[] = [];
  await page.route(STATS_ROUTE, (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({ json: stats("240.00", 2, 18) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");

  await expect(strip(page)).toContainText("Last 30 days");
  await expect(strip(page)).toContainText("€240 revenue · 2 bookings · 18 page views");
  await page.screenshot({ path: testInfo.outputPath("today-strip-1440.png") });
  // The Dashboard's own read: the 30 property-local days ending today (VAY-2594).
  expect(days(reads[0])).toBe(30);

  // Read again after a page change (Design Studio itself never reads the stats).
  const before = reads.length;
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Design Studio" })
    .click();
  await expect(page).toHaveURL(/\/design-studio$/);
  await expect.poll(() => reads.length).toBeGreaterThan(before);

  await strip(page).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(strip(page)).toContainText("€240 revenue · 2 bookings · 18 page views");
});

test("follows the range picked on the Dashboard on every page, until a reload (VAY-2594)", async ({
  page,
}, testInfo) => {
  // One booking per day of the range, so each range's numbers differ.
  await page.route(STATS_ROUTE, (route) => {
    const length = days(new URL(route.request().url()));
    return route.fulfill({ json: stats(`${length * 10}.00`, length, length * 3) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  await expect(strip(page)).toContainText("€300 revenue · 30 bookings · 90 page views");

  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(strip(page, "Last 7 days")).toContainText(
    "€70 revenue · 7 bookings · 21 page views",
  );
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(strip(page, "Today")).toContainText("€10 revenue · 1 booking · 3 page views");
  await page.getByRole("button", { name: "90 days", exact: true }).click();
  await expect(strip(page, "Last 90 days")).toContainText("€900 revenue · 90 bookings");
  await page.screenshot({ path: testInfo.outputPath("strip-90-days-1440.png") });

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(strip(page, "Last 90 days")).toContainText("€900 revenue · 90 bookings");

  await page.reload();
  await expect(strip(page)).toContainText("€300 revenue · 30 bookings · 90 page views");
});

test("keeps all zeros for a new property", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(strip(page)).toContainText("€0 revenue · 0 bookings · 0 page views");
});

test("shows revenue in the currency guests pay in, not Localization's default (VAY-2390)", async ({
  page,
}) => {
  // The stats come in the PMS pricing currency; Booking settings' default (LKR) is only what
  // guests see first on the booking page.
  await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: { ...defaultBookingAdminPropertySettings, default_currency: "LKR" } }),
  );
  await page.route(STATS_ROUTE, (route) => route.fulfill({ json: stats("240.00", 2, 18, "USD") }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");

  await expect(strip(page)).toContainText("$240 revenue · 2 bookings · 18 page views");
});

test("leaves the strip out when today's stats can't be read", async ({ page }) => {
  let reads = 0;
  await page.route(STATS_ROUTE, (route) => {
    reads += 1;
    return route.fulfill({ status: 403, json: { detail: "Forbidden" } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const denied = page.waitForResponse((response) => response.url().includes("/dashboard/stats"));
  await page.goto("/settings");
  await denied;
  await expect(page.getByRole("combobox", { name: "Search pages and settings" })).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
  // A refused read isn't repeated on every page change.
  const refused = reads;
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Design Studio" })
    .click();
  await expect(page).toHaveURL(/\/design-studio$/);
  await page.waitForLoadState("networkidle");
  expect(reads).toBe(refused);
});

test("skips the reads on phones, where the strip never shows", async ({ page }) => {
  let reads = 0;
  await page.route(STATS_ROUTE, (route) => {
    reads += 1;
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("combobox", { name: "Search pages and settings" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(reads).toBe(0);
  await expect(strip(page)).toBeHidden();
});

test("drops page views, then the whole strip, and never cuts a metric", async ({
  page,
}, testInfo) => {
  await page.route(STATS_ROUTE, (route) => route.fulfill({ json: stats("1234567.00", 14, 1204) }));
  await page.goto("/settings");
  for (const width of [1440, 1280, 1024, 900, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("combobox", { name: "Search pages and settings" })).toBeVisible();
    await page.waitForTimeout(200);
    const shown = await page.locator("header a[href='/dashboard']").evaluateAll((links) =>
      links
        .filter((link) => link.getBoundingClientRect().width > 0)
        .map((link) => ({
          text: link.lastElementChild?.textContent ?? "",
          clipped: link.scrollWidth > link.clientWidth,
        })),
    );
    if (width < 768) expect(shown).toEqual([]);
    for (const { text, clipped } of shown) {
      expect(clipped, `${width}px`).toBe(false);
      expect([
        "€1.2M revenue · 14 bookings · 1,204 page views",
        "€1.2M revenue · 14 bookings",
      ]).toContain(text);
    }
    await page.screenshot({ path: testInfo.outputPath(`today-strip-${width}.png`) });
  }
});
