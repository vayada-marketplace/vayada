import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const days = (start: string | null, end: string | null) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;

// bookings are direct bookings; booked are those made on the booking page (the conversion's).
type Numbers = { revenue: string; bookings: number; views: number; booked: number };
const NOW: Numbers = { revenue: "1240.00", bookings: 4, views: 82, booked: 4 };
const BEFORE: Numbers = { revenue: "1050.00", bookings: 3, views: 94, booked: 3 };
const NOTHING: Numbers = { revenue: "0.00", bookings: 0, views: 0, booked: 0 };

/** Stats, sparklines and funnel for the cards; `set` swaps what the next reads answer. */
async function mockCards(page: Page) {
  const reads = { stats: [] as URL[], sparklines: [] as URL[], funnel: [] as URL[] };
  let numbers = { current: NOW, previous: BEFORE, trend: [3, 5, 4, 8, 6, 7, 9] };
  const money = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });
  await page.route("**/api/booking/properties/*/dashboard/stats**", (route) => {
    reads.stats.push(new URL(route.request().url()));
    const metrics = (n: Numbers) => ({
      totalRevenue: money(n.revenue),
      bookingCount: n.bookings,
      conversionBookingCount: n.booked,
      conversionPageViewCount: n.views,
      avgNightlyRate: money("0.00"),
      pageViewCount: n.views,
    });
    return route.fulfill({
      json: {
        metrics: {
          current: metrics(numbers.current),
          previous: metrics(numbers.previous),
          nextArrivalDate: null,
          liveSinceDate: null,
        },
      },
    });
  });
  await page.route("**/api/booking/properties/*/dashboard/sparklines**", (route) => {
    reads.sparklines.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        sparklines: {
          points: numbers.trend.map((value) => ({
            revenue: money(String(value * 100)),
            bookingCount: value,
            avgNightlyRate: money("0.00"),
            // Page views fall while the rest rises, so one card's line is red.
            pageViewCount: value ? (10 - value) * 10 : 0,
          })),
        },
      },
    });
  });
  await page.route("**/dashboard/conversion-funnel?**", (route) => {
    reads.funnel.push(new URL(route.request().url()));
    const n = numbers.current;
    return route.fulfill({
      json: {
        funnel: {
          // previousCount is the step before, as the API sends it, not the previous period.
          steps: [
            ["page_visit", n.views, n.views],
            ["rate_selected", Math.round(n.views / 2), n.views],
            ["booking_completed", n.booked, Math.round(n.views / 2)],
          ].map(([stage, count, previousCount]) => ({
            stage,
            count,
            previousCount,
            percentOfVisits: null,
            conversionPercent: null,
          })),
          paymentMethods: [],
          biggestDrop: null,
        },
      },
    });
  });
  return {
    reads,
    set(next: Partial<typeof numbers>) {
      numbers = { ...numbers, ...next };
    },
  };
}

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("opens on the last 30 days with four cards, each changing relative to the period before (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { reads } = await mockCards(page);
  await page.goto("/dashboard");

  const range = page.getByRole("group", { name: "Date range" });
  await expect(range.getByRole("button")).toHaveText(["Today", "7 days", "30 days", "90 days"]);
  await expect(range.getByRole("button", { name: "30 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const main = page.locator("main");
  for (const label of ["Revenue", "Bookings", "Page Views", "Conversion rate"]) {
    await expect(main.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/Avg\. Nightly Rate/i)).toHaveCount(0);
  await expect(main.getByText("€1,240")).toBeVisible();
  // 4 booking page bookings of 82 page views; before, 3 of 94.
  await expect(main.getByText("4.88%", { exact: true })).toBeVisible();

  // Always a relative change, green up and red down; never points or amounts.
  await expect(main.getByText("↑ 18% vs prev. period")).toHaveClass(/text-\[#0F7A3D\]/);
  await expect(main.getByText("↑ 33% vs prev. period")).toBeVisible();
  await expect(main.getByText("↓ 13% vs prev. period")).toHaveClass(/text-\[#B42318\]/);
  await expect(main.getByText("↑ 53% vs prev. period")).toBeVisible();
  await expect(main.getByText(/\+€|pts/)).toHaveCount(0);
  // Trend lines follow each card's change; conversion has no daily series yet.
  await expect(main.locator('svg path[stroke="#16A34A"]')).toHaveCount(2);
  await expect(main.locator('svg path[stroke="#D92D20"]')).toHaveCount(1);
  await expect(main.locator('svg path[stroke="#D1D5DB"]')).toHaveCount(1);
  // Only the page views card opens a window so far.
  await expect(main.getByText("Details ›")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open page views breakdown" })).toContainText(
    "Details ›",
  );

  // The last 30 days end today and compare with the 30 days right before them.
  const stats = reads.stats.at(-1)!.searchParams;
  expect(days(stats.get("periodStart"), stats.get("periodEnd"))).toBe(29);
  expect(days(stats.get("previousPeriodEnd"), stats.get("periodStart"))).toBe(1);
  expect(days(stats.get("previousPeriodStart"), stats.get("previousPeriodEnd"))).toBe(29);
  // The conversion card comes from the stats; the funnel is read for the range only.
  const funnelWindows = reads.funnel.map((url) => url.searchParams.get("windowStart"));
  expect(funnelWindows).toContain(stats.get("periodStart"));
  expect(funnelWindows).not.toContain(stats.get("previousPeriodStart"));
  await page.screenshot({ path: testInfo.outputPath("dashboard-30-days-1440.png") });
});

test("Today compares with yesterday and 90 days with the 90 days before (VAY-2594)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { reads } = await mockCards(page);
  await page.goto("/dashboard");
  const range = page.getByRole("group", { name: "Date range" });
  await expect(range.getByRole("button", { name: "30 days" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await range.getByRole("button", { name: "Today" }).click();
  await expect(range.getByRole("button", { name: "Today" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => {
      const last = reads.stats.at(-1)!.searchParams;
      return last.get("periodStart") === last.get("periodEnd");
    })
    .toBe(true);
  const todayRead = reads.stats.at(-1)!.searchParams;
  expect(todayRead.get("previousPeriodStart")).toBe(todayRead.get("previousPeriodEnd"));
  expect(days(todayRead.get("previousPeriodStart"), todayRead.get("periodStart"))).toBe(1);
  // A single day has no trend of its own: its lines show the 7 days ending today.
  await expect
    .poll(() => {
      const last = reads.sparklines.at(-1)!.searchParams;
      return days(last.get("windowStart"), last.get("windowEnd"));
    })
    .toBe(6);

  await range.getByRole("button", { name: "90 days" }).click();
  await expect
    .poll(() => {
      const last = reads.stats.at(-1)!.searchParams;
      return days(last.get("periodStart"), last.get("periodEnd"));
    })
    .toBe(89);
  const quarter = reads.stats.at(-1)!.searchParams;
  expect(days(quarter.get("previousPeriodEnd"), quarter.get("periodStart"))).toBe(1);
  expect(days(quarter.get("previousPeriodStart"), quarter.get("previousPeriodEnd"))).toBe(89);
  // The funnel reads the same 90 days, which the API allows.
  await expect
    .poll(() =>
      reads.funnel.some(
        (url) =>
          url.searchParams.get("windowStart") === quarter.get("periodStart") &&
          days(url.searchParams.get("windowStart"), url.searchParams.get("windowEnd")) === 89,
      ),
    )
    .toBe(true);
});

test("says no data, no change and up from nothing in grey or green", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = await mockCards(page);
  cards.set({ current: NOTHING, previous: NOTHING, trend: [0, 0, 0, 0, 0, 0, 0] });
  await page.goto("/dashboard");
  const main = page.locator("main");
  await expect(main.getByText("No data yet")).toHaveCount(4);
  await expect(main.locator('svg path[stroke="#D1D5DB"]')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("dashboard-empty-1440.png") });

  // Before: the same bookings, no revenue and no page views, so no conversion rate to compare.
  cards.set({ current: NOW, previous: { ...NOTHING, bookings: 4, booked: 4 } });
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(main.getByText("↑ from 0 in prev. period")).toHaveCount(2);
  await expect(main.getByText("± 0% vs prev. period")).toHaveCount(1);
  await expect(main.getByText("4.88%", { exact: true })).toBeVisible();
  // Revenue, bookings and page views have a change line; the conversion card has none.
  await expect(main.getByText(/prev\. period|No data yet/)).toHaveCount(3);
});

test("cards wrap on a phone without scrolling sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1400 });
  await mockCards(page);
  await page.goto("/dashboard");
  const range = page.getByRole("group", { name: "Date range" });
  await expect(range.getByRole("button", { name: "90 days" })).toBeInViewport({ ratio: 1 });
  await expect(page.locator("main").getByText("↑ 53% vs prev. period")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("dashboard-30-days-390.png"), fullPage: true });
  // Page content scrolls inside <main>, so check it rather than the document.
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
