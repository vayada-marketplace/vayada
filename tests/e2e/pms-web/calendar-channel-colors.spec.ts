import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebReservation,
} from "../support/pmsWebMocks";

// VAY-2153: channel bar colours live in lib/constants/statusStyles.ts. When
// Tailwind did not scan lib/, bg-yellow-500 was never generated and Expedia
// bars rendered white text on no background.
const CHANNEL_BOOKINGS = [
  { guest: "Dana Direct", channel: "direct", checkIn: "2026-08-12", checkOut: "2026-08-14" },
  { guest: "Ari Airbnb", channel: "airbnb", checkIn: "2026-08-14", checkOut: "2026-08-16" },
  { guest: "Bea Booking", channel: "booking_com", checkIn: "2026-08-16", checkOut: "2026-08-18" },
  { guest: "Eve Expedia", channel: "expedia", checkIn: "2026-08-18", checkOut: "2026-08-20" },
  { guest: "Oli Other", channel: "agoda", checkIn: "2026-08-20", checkOut: "2026-08-22" },
];

const TRANSPARENT = "rgba(0, 0, 0, 0)";

async function mockChannelBookings(page: Page) {
  const items = CHANNEL_BOOKINGS.map(({ guest, channel, checkIn, checkOut }, index) => ({
    ...pmsWebReservation,
    guestBookingId: `guest_booking_${channel}`,
    bookingReference: `VAY-CH${index}`,
    source: channel === "direct" ? "direct_booking" : "channel",
    stay: { ...pmsWebReservation.stay, checkIn, checkOut },
    primaryGuest: { ...pmsWebReservation.primaryGuest, displayName: guest },
    assignments: [
      { ...pmsWebReservation.assignments[0], assignmentId: `assignment_${channel}`, channel },
    ],
  }));
  const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
  await page.unroute(reservationsRoute);
  await page.route(reservationsRoute, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items,
        sourceFreshness: {},
        pagination: { total: items.length, limit: 500, offset: 0 },
      },
    }),
  );
}

async function expectDistinctChannelBackgrounds(barFor: (guest: string) => Locator) {
  const colors: string[] = [];
  for (const { guest } of CHANNEL_BOOKINGS) {
    const bar = barFor(guest);
    await expect(bar).toBeVisible();
    const color = await bar.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(color, `${guest} has a background`).not.toBe(TRANSPARENT);
    colors.push(color);
  }
  expect(new Set(colors).size, `channel colours ${colors.join(" | ")}`).toBe(colors.length);
}

test.describe("PMS calendar channel colours", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await mockChannelBookings(page);
  });

  test("gives every channel's booking bar a visible background in the timeline", async ({
    page,
  }, testInfo) => {
    await page.goto("/calendar");
    const bar = (guest: string) => page.locator('[data-bar="booking"]', { hasText: guest });
    await expect(bar("Eve Expedia")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("calendar-timeline.png") });

    await expectDistinctChannelBackgrounds(bar);
  });

  test("gives every channel's booking bar a visible background in the month view", async ({
    page,
  }, testInfo) => {
    await page.goto("/calendar");
    await page.getByRole("button", { name: "Room view options" }).click();
    await page.getByRole("button", { name: "Month", exact: true }).click();
    const bar = (guest: string) => page.locator("main button", { hasText: guest }).first();
    await expect(bar("Eve Expedia")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("calendar-month.png") });

    await expectDistinctChannelBackgrounds(bar);
  });

  test("colours the channel badge of a mobile day's bookings", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/calendar");
    await page.locator('[data-day="2026-08-18"]').click();
    const badge = page
      .getByRole("button", { name: /Eve Expedia/ })
      .locator('[class~="w-8"][class~="rounded-full"]');
    await expect(badge).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("calendar-mobile.png") });

    const color = await badge.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(color, "Eve Expedia's badge has a background").not.toBe(TRANSPARENT);
  });
});
