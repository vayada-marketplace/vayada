import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const money = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });

function windowDays(url: URL, start = "windowStart", end = "windowEnd"): string[] {
  const days: string[] = [];
  const last = url.searchParams.get(end) ?? "";
  for (
    let day = new Date(`${url.searchParams.get(start)}T00:00:00Z`);
    day.toISOString().slice(0, 10) <= last;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    days.push(day.toISOString().slice(0, 10));
  return days;
}

const booking = (
  reference: string,
  total: string,
  status: "confirmed" | "canceled",
  roomNames: string[],
) => ({
  id: `b0000000-0000-4000-8000-00000000${reference.slice(3)}`,
  reference,
  bookedOn: "2026-11-21",
  status,
  checkIn: "2026-12-12",
  checkOut: "2026-12-17",
  nights: 5,
  roomCount: 1,
  roomNames,
  total: money(total),
  countedInRevenue: true,
});

/** 30 days: €1,240 from 4 bookings (4 on the booking page) and 82 page views; before, 3 and 94. */
async function mockDetails(page: Page, options: { bookingsHidden?: boolean } = {}) {
  const reads = { details: [] as URL[] };
  await page.route("**/api/booking/properties/*/dashboard/stats**", (route) => {
    const metrics = (revenue: string, bookings: number, views: number) => ({
      totalRevenue: money(revenue),
      bookingCount: bookings,
      conversionBookingCount: bookings,
      conversionPageViewCount: views,
      avgNightlyRate: money("0.00"),
      pageViewCount: views,
    });
    return route.fulfill({
      json: {
        metrics: {
          current: metrics("1240.00", 4, 82),
          previous: metrics("1050.00", 3, 94),
          nextArrivalDate: null,
          liveSinceDate: null,
        },
      },
    });
  });
  await page.route("**/api/booking/properties/*/dashboard/revenue-days**", (route) => {
    const days = windowDays(new URL(route.request().url()));
    return route.fulfill({
      json: {
        revenueDays: {
          days: days.map((date, index) => {
            const booked = index === days.length - 3 || index === days.length - 12;
            return {
              date,
              revenue: money(booked ? "620.00" : "0.00"),
              bookingCount: booked ? 2 : 0,
              bookingPageBookingCount: booked ? 2 : 0,
              otherCurrencyBookingCount: 0,
            };
          }),
        },
      },
    });
  });
  await page.route("**/api/booking/properties/*/dashboard/page-views**", (route) => {
    const url = new URL(route.request().url());
    const days = windowDays(url);
    return route.fulfill({
      json: {
        pageViews: {
          timeZone: "Europe/Berlin",
          windowStart: days[0],
          windowEnd: days.at(-1),
          previousWindowStart: days[0],
          previousWindowEnd: days.at(-1),
          buckets: days.map((date, index) => ({ date, count: index % 3 })),
          previousBuckets: [],
          total: 0,
          previousTotal: 0,
        },
      },
    });
  });
  await page.route("**/api/booking/properties/*/dashboard/details**", (route) => {
    const url = new URL(route.request().url());
    reads.details.push(url);
    return route.fulfill({
      json: {
        details: {
          pageViewsCountedFrom: url.searchParams.get("periodStart"),
          roomTypes: [
            { name: "Deluxe Room", revenue: money("740.00"), previousRevenue: money("500.00") },
            { name: "Garden Bungalow", revenue: money("500.00"), previousRevenue: money("550.00") },
          ],
          leadTimes: [
            { bucket: "0-7", bookingCount: 1, previousBookingCount: 0 },
            { bucket: "8-30", bookingCount: 0, previousBookingCount: 1 },
            { bucket: "31-90", bookingCount: 3, previousBookingCount: 2 },
            { bucket: "90+", bookingCount: 0, previousBookingCount: 0 },
          ],
          canceledBookingCount: 1,
          topBookings: [
            booking("VB-1051", "500.00", "confirmed", ["Garden Bungalow"]),
            booking("VB-1050", "400.00", "confirmed", ["Deluxe Room"]),
          ],
          recentBookings: [
            booking("VB-1053", "90.00", "canceled", ["Deluxe Room"]),
            booking("VB-1051", "500.00", "confirmed", ["Garden Bungalow"]),
          ],
        },
        bookingsHidden: options.bookingsHidden === true,
        canOpenInPms: false,
      },
    });
  });
  return reads;
}

const details = (page: Page) => page.getByRole("dialog", { name: /details$/ });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("every card opens Details on its metric, and the tabs switch without closing (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads = await mockDetails(page);
  await page.goto("/dashboard");
  // Every card is clickable now.
  await expect(page.locator("main").getByText("Details ›")).toHaveCount(6);

  await page.getByRole("button", { name: "Open revenue details" }).first().click();
  const dialog = details(page);
  await expect(dialog).toHaveAccessibleName("Revenue details");
  await expect(dialog.getByText("Last 30 days · vs previous period")).toBeVisible();
  await expect(dialog.getByText("€1,240", { exact: true })).toBeVisible();
  await expect(dialog.getByText("↑ 18% vs previous period")).toHaveClass(/text-\[#0F7A3D\]/);
  await expect(dialog.getByText("Revenue per day")).toBeVisible();
  // By room type: amount and share, with the share's change.
  await expect(dialog.getByText("€740 · 60%")).toBeVisible();
  await expect(dialog.getByText("Top bookings")).toBeVisible();
  await expect(dialog.getByText("VB-1051")).toBeVisible();
  // "Dec 12 – 17" in English, however the language writes a date range.
  await expect(dialog.getByText(/^Dec 12\s?–\s?17 · 5 nights · Garden Bungalow$/)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open booking VB-1051" })).toHaveAttribute(
    "href",
    "/reservations?search=VB-1051",
  );
  // Hover shows the day and its exact value.
  await dialog.locator('[aria-label$=": €620"]').first().hover();
  await expect(dialog.getByRole("tooltip")).toContainText("€620");
  await page.screenshot({ path: testInfo.outputPath("details-revenue-1440.png") });

  await dialog.getByRole("tab", { name: "Bookings" }).click();
  await expect(dialog).toHaveAccessibleName("Bookings details");
  await expect(dialog.getByText("1 cancellation (20%) not included")).toBeVisible();
  await expect(dialog.getByText("Lead time (booking → arrival)")).toBeVisible();
  const leads = await dialog.getByText(/^\d+–?\d*\+? days$/).allTextContents();
  expect(leads).toEqual(["0–7 days", "8–30 days", "31–90 days", "90+ days"]);
  await expect(dialog.getByText("Cancelled")).toBeVisible();
  await expect(dialog.getByText(/^Booked Nov 21 · 5 nights · Deluxe Room$/)).toBeVisible();

  await dialog.getByRole("tab", { name: "Page views" }).click();
  await expect(dialog.getByText("82", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Page views per day")).toBeVisible();

  await dialog.getByRole("tab", { name: "Conversion" }).click();
  await expect(dialog.getByText("4.88%", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Bookings on your booking page ÷ page views (4 of 82)"),
  ).toBeVisible();
  // Weekly: a value above every bar and its own label below.
  await expect(dialog.getByText(/^W[1-5]$/)).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("details-conversion-1440.png") });
  // The details are read for the window's range and the one before; a dev build's strict mode
  // may read twice, with the same dates.
  expect(new Set(reads.details.map((url) => url.search)).size).toBe(1);
  expect(reads.details[0].searchParams.get("previousPeriodEnd")).not.toBeNull();
});

test("the window is centered, 760px wide, over the whole page, and closes three ways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockDetails(page);
  await page.goto("/dashboard");
  const card = page.getByRole("button", { name: "Open page views details" });
  await card.click();
  const dialog = details(page);
  await expect(dialog).toHaveAccessibleName("Page Views details");
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.width)).toBe(760);
  expect(Math.round(box.x + box.width / 2)).toBe(720);
  // VAY-2590: the backdrop starts at the very top.
  const backdrop = (await page
    .getByRole("button", { name: "Close details" })
    .first()
    .boundingBox())!;
  expect(backdrop).toMatchObject({ x: 0, y: 0, height: 1000 });
  await expect(dialog.getByRole("button", { name: "Close details" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeFocused();

  await page.getByRole("button", { name: "Open revenue details" }).last().click();
  await expect(dialog).toHaveAccessibleName("Revenue details");
  await page.mouse.click(20, 980);
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Open conversion details" }).last().click();
  await expect(dialog).toHaveAccessibleName("Conversion rate details");
  await dialog.getByRole("button", { name: "Close details" }).click();
  await expect(dialog).toHaveCount(0);
});

test("without access to reservations the lists say so", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockDetails(page, { bookingsHidden: true });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open bookings details" }).click();
  const dialog = details(page);
  await expect(
    dialog.getByText("Only people with access to reservations can see each booking."),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: /^Open booking/ })).toHaveCount(0);
});

test("on a phone the window fits and its tabs scroll", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDetails(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open bookings details" }).click();
  const dialog = details(page);
  await expect(dialog.getByText("Recent bookings")).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(box.width)).toBe(390 - 32);
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("details-bookings-390.png") });
});
