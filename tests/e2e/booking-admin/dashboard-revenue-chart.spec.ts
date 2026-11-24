import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
import { mockSetupExitHandoff } from "../support/setupExitHandoff";

const money = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });

function windowDays(url: URL): string[] {
  const days: string[] = [];
  const end = url.searchParams.get("windowEnd") ?? "";
  for (
    let day = new Date(`${url.searchParams.get("windowStart")}T00:00:00Z`);
    day.toISOString().slice(0, 10) <= end;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    days.push(day.toISOString().slice(0, 10));
  return days;
}

/** Bookings 20, 10 and 2 days before the window's end; the last one only in another currency. */
async function mockRevenue(
  page: Page,
  options: { canOpenInPms?: boolean; bookingsHidden?: boolean } = {},
) {
  const windows: URL[] = [];
  let days: string[] = [];
  const booked = () => {
    const n = days.length;
    return n < 21
      ? {}
      : {
          [days[n - 21]]: { revenue: "1240.00", bookings: 2 },
          [days[n - 11]]: { revenue: "350.00", bookings: 1 },
          [days[n - 3]]: { revenue: "0.00", bookings: 1 },
        };
  };
  await page.route("**/api/booking/properties/*/dashboard/revenue-days**", (route) => {
    const url = new URL(route.request().url());
    windows.push(url);
    days = windowDays(url);
    const byDay: Record<string, { revenue: string; bookings: number }> = booked();
    return route.fulfill({
      json: {
        revenueDays: {
          days: days.map((date) => ({
            date,
            revenue: money(byDay[date]?.revenue ?? "0.00"),
            bookingCount: byDay[date]?.bookings ?? 0,
            otherCurrencyBookingCount: 0,
          })),
        },
      },
    });
  });
  const dayReads: string[] = [];
  await page.route("**/api/booking/properties/*/dashboard/day-bookings**", (route) => {
    const date = new URL(route.request().url()).searchParams.get("date") ?? "";
    dayReads.push(date);
    const n = days.length;
    const list =
      date === days[n - 21]
        ? [
            [
              "b0000000-0000-4000-8000-000000001050",
              "VB-1050",
              "740.00",
              "EUR",
              true,
              ["Deluxe Room"],
            ],
            [
              "b0000000-0000-4000-8000-000000001051",
              "VB-1051",
              "500.00",
              "EUR",
              true,
              ["Garden Bungalow", "Family Suite"],
            ],
          ]
        : date === days[n - 11]
          ? [["b0000000-0000-4000-8000-000000001052", "VB-1052", "350.00", "EUR", true, []]]
          : [
              [
                "b0000000-0000-4000-8000-000000001053",
                "VB-1053",
                "120.00",
                "GBP",
                false,
                ["Deluxe Room"],
              ],
            ];
    return route.fulfill({
      json: {
        dayBookings: {
          date,
          revenue: money(
            date === days[n - 21] ? "1240.00" : date === days[n - 11] ? "350.00" : "0.00",
          ),
          bookingCount: list.length,
          roomNights: list.length * 4,
          bookings: list.map(([id, reference, total, currency, counted, roomNames]) => ({
            id,
            reference,
            checkIn: "2026-12-27",
            checkOut: "2027-01-01",
            nights: 5,
            roomCount: 1,
            roomNames,
            total: { amountDecimal: total, currency },
            countedInRevenue: counted,
          })),
        },
        bookingsHidden: options.bookingsHidden === true,
        canOpenInPms: options.canOpenInPms === true,
      },
    });
  });
  return { windows, dayReads, days: () => days };
}

const chart = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Revenue over time" }) });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("one bar per day of direct bookings by booking date, with the day's tooltip (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const revenue = await mockRevenue(page);
  await page.goto("/dashboard");

  const section = chart(page);
  await expect(section.getByText("Direct bookings, by booking date")).toBeVisible();
  // 30 days by default: three of them with bookings open their day.
  await expect
    .poll(() => revenue.windows.at(-1) && windowDays(revenue.windows.at(-1)!).length)
    .toBe(30);
  await expect(section.getByRole("button", { name: /open bookings$/ })).toHaveCount(3);
  // Axis: a round top whose half is round too.
  await expect(section.getByText("€2K", { exact: true })).toBeVisible();
  await expect(section.getByText("€1K", { exact: true })).toBeVisible();

  const best = section.getByRole("button", { name: /open bookings$/ }).first();
  await best.hover();
  const tooltip = section.getByRole("tooltip");
  await expect(tooltip).toContainText("€1.2K");
  await expect(tooltip).toContainText("2 bookings · click to view");
  // The other bars fade while one is hovered.
  await expect(best.locator("span").last()).toHaveClass(/bg-\[#1E3AD8\]/);
  await expect(
    section
      .getByRole("button", { name: /open bookings$/ })
      .nth(1)
      .locator("span")
      .last(),
  ).toHaveClass(/bg-\[#9AABF9\]/);
  await page.screenshot({ path: testInfo.outputPath("revenue-chart-hover-1440.png") });

  // A day without bookings says so and doesn't open.
  const box = await section.locator("div.items-end > div").first().boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 1);
  await expect(section.getByRole("tooltip")).toContainText("No bookings");

  // Today is one bar; 90 days, ninety.
  const range = page.getByRole("group", { name: "Date range" });
  await range.getByRole("button", { name: "Today" }).click();
  await expect.poll(() => windowDays(revenue.windows.at(-1)!).length).toBe(1);
  await range.getByRole("button", { name: "90 days" }).click();
  await expect.poll(() => windowDays(revenue.windows.at(-1)!).length).toBe(90);
  await expect(section.locator("div.items-end > *")).toHaveCount(90);
});

test("a day's bookings open pinned 120px from the top, with arrows to the next and previous day", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const revenue = await mockRevenue(page);
  await page.goto("/dashboard");
  const section = chart(page);
  await section
    .getByRole("button", { name: /open bookings$/ })
    .first()
    .click();

  const dialog = page.getByRole("dialog", { name: /^Bookings on / });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Direct bookings made on this day")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  expect(Math.round((await dialog.boundingBox())!.y)).toBe(120);
  await expect(dialog.getByText("€1.2K", { exact: true })).toBeVisible();
  await expect(dialog.getByText("8", { exact: true })).toBeVisible();
  await expect(dialog.getByText("VB-1050")).toBeVisible();
  await expect(dialog.getByText(/Arrival .+ · 5 nights · Deluxe Room/)).toBeVisible();
  await expect(dialog.getByText(/· Garden Bungalow, Family Suite$/)).toBeVisible();
  // Without PMS access, Open booking finds it in Reservations here, in a new tab.
  const open = dialog.getByRole("link", { name: "Open booking VB-1050" });
  await expect(open).toHaveAttribute("href", "/reservations?search=VB-1050");
  await expect(open).toHaveAttribute("target", "_blank");
  await page.screenshot({ path: testInfo.outputPath("day-window-1440.png") });

  // The first day with bookings: no way back. The header stays put as the list changes.
  await expect(dialog.getByRole("button", { name: "Previous day with bookings" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Next day with bookings" }).click();
  await expect(dialog.getByText("VB-1052")).toBeVisible();
  await expect(dialog.getByText("VB-1050")).toHaveCount(0);
  expect(Math.round((await dialog.boundingBox())!.y)).toBe(120);
  await dialog.getByRole("button", { name: "Next day with bookings" }).click();
  // A booking in another currency: shown in its own, not in the day's revenue.
  await expect(dialog.getByText("£120", { exact: true })).toBeVisible();
  await expect(dialog.getByText("€0", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next day with bookings" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Previous day with bookings" }).click();
  await expect(dialog.getByText("VB-1052")).toBeVisible();
  const days = revenue.days();
  // A dev build's strict mode reads twice on open; the days asked for, in order, are what count.
  expect(revenue.dayReads.filter((day, index, all) => day !== all[index - 1])).toEqual([
    days[9],
    days[19],
    days[27],
    days[19],
  ]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await section
    .getByRole("button", { name: /open bookings$/ })
    .first()
    .click();
  await expect(dialog).toBeVisible();
  // A click on the dark backdrop closes it too.
  await page.mouse.click(20, 880);
  await expect(dialog).toHaveCount(0);
});

test("Open booking opens it in PMS on the property for people PMS lets in", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem("access_token");
    localStorage.removeItem("token_expires_at");
  });
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.request().method() === "OPTIONS"
      ? fulfillCorsPreflight(route)
      : route.fulfill({
          headers: corsHeaders(route),
          json: {
            accessToken: "test-access-token",
            csrfToken: "test-csrf-token",
            organizationId: "11111111-1111-4111-8111-111111111111",
            workosOrganizationId: "org_workos_hotel_group",
            organizationKind: "hotel_group",
            resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
            user: {
              id: "user_1",
              email: "owner@example.com",
              name: "Booking Owner",
              status: "active",
              workosUserId: "user_workos_owner",
            },
          },
        }),
  );
  await mockRevenue(page, { canOpenInPms: true });
  const pms = await mockSetupExitHandoff(
    page,
    baseURL,
    BOOKING_ADMIN_PROPERTY_ID,
    "/bookings/b0000000-0000-4000-8000-000000001050",
  );
  await page.goto("/dashboard");
  await chart(page)
    .getByRole("button", { name: /open bookings$/ })
    .first()
    .click();
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("link", { name: "Open booking VB-1050" }).click(),
  ]);
  await expect.poll(() => tab.url()).toBe(pms);
  // The dashboard stays where it was.
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("people without access to reservations see the day's totals, not its bookings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRevenue(page, { bookingsHidden: true });
  await page.goto("/dashboard");
  await chart(page)
    .getByRole("button", { name: /open bookings$/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /^Bookings on / });
  await expect(
    dialog.getByText("Only people with access to reservations can see each booking."),
  ).toBeVisible();
  await expect(dialog.getByRole("link", { name: /^Open booking/ })).toHaveCount(0);
});

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("on a phone the 90 bars fit, a first tap shows the day and a second opens it", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await mockRevenue(page);
    await page.goto("/dashboard");
    const range = page.getByRole("group", { name: "Date range" });
    await range.getByRole("button", { name: "90 days" }).click();
    const section = chart(page);
    await expect(section.locator("div.items-end > *")).toHaveCount(90);
    const main = page.locator("main");
    expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);

    // The whole column is the button: tap its middle, with the chart settled mid-screen.
    const bar = section.getByRole("button", { name: /open bookings$/ }).first();
    await section.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await expect.poll(async () => (await bar.boundingBox())?.y).toBeGreaterThan(0);
    const box = (await bar.boundingBox())!;
    const tap = () => page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await tap();
    await expect(section.getByRole("tooltip")).toContainText("2 bookings · click to view");
    await expect(page.getByRole("dialog", { name: /^Bookings on / })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("revenue-chart-tap-390.png") });
    // A person reads the tooltip before tapping again.
    await page.waitForTimeout(600);
    await tap();
    const dialog = page.getByRole("dialog", { name: /^Bookings on / });
    await expect(dialog).toBeVisible();
    const frame = (await dialog.boundingBox())!;
    expect(Math.round(frame.x)).toBe(16);
    expect(Math.round(frame.width)).toBe(390 - 32);
    await page.screenshot({ path: testInfo.outputPath("day-window-390.png") });
  });
});
