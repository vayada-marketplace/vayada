import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const days = (start: string | null, end: string | null) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;

test("summary cards show short labels, sparklines, per-metric comparisons and a grey empty state", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const statsUrls: URL[] = [];
  const sparklineUrls: URL[] = [];
  let empty = false;
  await page.route("**/api/booking/properties/*/dashboard/stats**", (route) => {
    statsUrls.push(new URL(route.request().url()));
    const money = (amount: string) => ({ amountDecimal: empty ? "0.00" : amount, currency: "EUR" });
    const metrics = (revenue: string, bookings: number, rate: string, views: number) => ({
      totalRevenue: money(revenue),
      bookingCount: empty ? 0 : bookings,
      avgNightlyRate: money(rate),
      pageViewCount: empty ? 0 : views,
    });
    return route.fulfill({
      json: {
        metrics: {
          current: metrics("1240.00", 4, "310.00", 82),
          previous: metrics("1050.00", 3, "288.00", 94),
          nextArrivalDate: "2026-08-20",
          liveSinceDate: null,
        },
      },
    });
  });
  await page.route("**/api/booking/properties/*/dashboard/sparklines**", (route) => {
    sparklineUrls.push(new URL(route.request().url()));
    const values = empty ? [0, 0, 0, 0, 0, 0, 0] : [3, 5, 4, 8, 6, 7, 9];
    return route.fulfill({
      json: {
        sparklines: {
          points: values.map((value) => ({
            revenue: { amountDecimal: String(value * 100), currency: "EUR" },
            bookingCount: value,
            avgNightlyRate: { amountDecimal: String(300 + value), currency: "EUR" },
            pageViewCount: value * 10,
          })),
        },
      },
    });
  });

  await page.goto("/dashboard");
  for (const label of ["Revenue", "Bookings", "Avg. Nightly Rate", "Page Views"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Revenue Today")).toHaveCount(0);
  await expect(page.getByText("€1,240")).toBeVisible();
  await expect(page.getByText("↑ +18% vs same day last week")).toHaveClass(/text-green-600/);
  await expect(page.getByText("↑ +1 vs same day last week")).toBeVisible();
  await expect(page.getByText("↑ +€22 vs same day last week")).toBeVisible();
  await expect(page.getByText("↓ -12 vs same day last week")).toHaveClass(/text-red-500/);
  await expect(page.getByText(/Next arrival|booking rate/)).toHaveCount(0);
  await expect(page.locator('svg path[stroke="#16A34A"]')).toHaveCount(4);
  // Today compares with the same weekday last week and charts the 7 days ending today.
  const todayStats = statsUrls.at(-1)!.searchParams;
  expect(days(todayStats.get("previousPeriodStart"), todayStats.get("periodStart"))).toBe(7);
  expect(todayStats.get("previousPeriodStart")).toBe(todayStats.get("previousPeriodEnd"));
  const todaySparkline = sparklineUrls.at(-1)!.searchParams;
  expect(days(todaySparkline.get("windowStart"), todaySparkline.get("windowEnd"))).toBe(6);
  await page.screenshot({ path: testInfo.outputPath("summary-cards-today.png") });

  await page.getByRole("button", { name: "This week", exact: true }).click();
  await expect(page.getByText("↑ +18% vs last week")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page views breakdown" })).toContainText(
    "↓ -12 vs last week",
  );

  empty = true;
  await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
  await expect(page.getByText("No data yet")).toHaveCount(4);
  await expect(page.locator('svg path[stroke="#D1D5DB"]')).toHaveCount(4);
  await expect(page.locator('svg path[stroke="#16A34A"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("summary-cards-empty.png") });

  empty = false;
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await expect(page.locator('svg path[stroke="#16A34A"]')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.screenshot({ path: testInfo.outputPath("summary-cards-mobile.png"), fullPage: true });
  // Page content scrolls inside <main>, so check it rather than the document.
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});
