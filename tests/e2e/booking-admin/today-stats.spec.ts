import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const STATS_ROUTE = "**/api/booking/properties/*/dashboard/stats**";
const money = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });

function stats(revenue: string, bookingCount: number, pageViewCount: number) {
  const zero = { totalRevenue: money("0.00"), bookingCount: 0, avgNightlyRate: money("0.00") };
  return {
    metrics: {
      current: {
        totalRevenue: money(revenue),
        bookingCount,
        avgNightlyRate: money("120.00"),
        pageViewCount,
      },
      previous: { ...zero, pageViewCount: 0 },
      nextArrivalDate: null,
      liveSinceDate: null,
    },
  };
}

const strip = (page: Page) => page.locator("header").getByRole("link", { name: /^Today/ });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("shows today's Dashboard numbers next to the property and opens the Dashboard (VAY-2203)", async ({
  page,
}, testInfo) => {
  const reads: URL[] = [];
  await page.route(STATS_ROUTE, (route) => {
    reads.push(new URL(route.request().url()));
    return route.fulfill({ json: stats("240.00", 2, 18) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");

  await expect(strip(page)).toContainText("Today");
  await expect(strip(page)).toContainText("€240 revenue · 2 bookings · 18 page views");
  await page.screenshot({ path: testInfo.outputPath("today-strip-1440.png") });
  // The Dashboard's Today read: one property-local day.
  const today = reads[0].searchParams;
  expect(today.get("periodStart")).toBe(today.get("periodEnd"));

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

test("keeps all zeros for a new property", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await expect(strip(page)).toContainText("€0 revenue · 0 bookings · 0 page views");
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
