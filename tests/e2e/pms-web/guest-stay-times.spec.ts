import { expect, test, type Page } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";
import {
  PMS_WEB_OWNER_PERMISSIONS,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebGuestRules,
  pmsWebReservation,
} from "../support/pmsWebMocks";

// VAY-2455: the PMS shows the check-in and check-out times guests see on the booking page (its guest rules),
// not a fixed "from 15:00" and "by 12:00". Staff who can't read the guest rules see the days alone.

async function mockBooking(page: Page) {
  // The shared reservations mock never answers one reservation (its glob stops at "/").
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) => route.fulfill({ json: { item: pmsWebReservation } }),
  );
  for (const [path, json] of [
    ["notes", { items: [] }],
    ["additional-guests", { items: [] }],
    ["change-request", null],
  ] as const)
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/${path}`,
      (route) => route.fulfill({ json }),
    );
}

function countGuestRuleReads(page: Page) {
  const reads = { count: 0 };
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/booking/properties/${PMS_WEB_PROPERTY_ID}/guest-rules`))
      reads.count += 1;
  });
  return reads;
}

test.describe("PMS check-in and check-out times", () => {
  test.use({ timezoneId: "Europe/Vienna" });

  test.beforeEach(async ({ page }) => {
    // The test booking leaves on 17 August, so it is today's departure.
    await page.clock.install({ time: new Date("2026-08-17T08:00:00Z") });
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await mockBooking(page);
  });

  test("shows the booking page's times on the booking and the dashboard", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.route(`**/api/booking/properties/${PMS_WEB_PROPERTY_ID}/guest-rules`, (route) =>
      route.fulfill({ json: pmsWebGuestRules({ checkInTime: "14:00", checkOutTime: "10:30" }) }),
    );

    await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
    await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
    await expect(page.getByText("from 14:00", { exact: true })).toBeVisible();
    await expect(page.getByText("by 10:30", { exact: true })).toBeVisible();
    await expect(page.getByText(/^(from 15:00|by 12:00)$/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("booking-times.png") });
    await assertHealthy();

    await page.goto("/dashboard");
    const departures = page.locator('section[aria-labelledby="departures-heading"]');
    await expect(departures).toContainText("Check-out by 10:30 · ");
    await departures.getByRole("button", { name: /Ada Lovelace/ }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Ada Lovelace" })).toContainText(
      "Today · by 10:30 · 2 night(s)",
    );
    await page.screenshot({ path: testInfo.outputPath("dashboard-departure-times.png") });
  });

  test("shows the days without a time to staff who can't read the guest rules", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.route("**/api/identity/staff/self-access", (route) =>
      route.fulfill({
        json: {
          membershipId: "pms-front-desk-membership",
          roleKey: "front_desk",
          permissions: PMS_WEB_OWNER_PERMISSIONS.filter(
            (permission) => permission !== "booking.settings.manage",
          ),
        },
      }),
    );
    const reads = countGuestRuleReads(page);

    await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
    await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
    await expect(page.getByText(/^(from|by) \d\d:\d\d$/)).toHaveCount(0);
    await assertHealthy();

    await page.goto("/dashboard");
    const departures = page.locator('section[aria-labelledby="departures-heading"]');
    await expect(departures).toContainText("Ada Lovelace");
    await expect(departures).not.toContainText("Check-out by");
    await departures.getByRole("button", { name: /Ada Lovelace/ }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Ada Lovelace" })).toContainText(
      "Today · 2 night(s)",
    );
    expect(reads.count).toBe(0);
  });
});
