import { expect, test, type Page } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

const EXIT_URL = `/dashboard?setup=incomplete&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`;

async function mockSetupStatus(page: Page, unfinished: boolean) {
  await page.route("**/api/hotel-setup/status**", (route) =>
    route.fulfill({
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId: "org_hotel_group",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        propertyDisplayName: "Alpenrose",
        taskOverrides: unfinished
          ? {
              rooms_rates_availability: {
                ownerProgress: "in_progress",
                readiness: "actionable",
                actionableBy: "owner",
                reasonCodes: ["rooms_missing"],
              },
            }
          : {},
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("a hotel that left setup unfinished lands on the dashboard with a way back (VAY-2249)", async ({
  page,
}, testInfo) => {
  await mockSetupStatus(page, true);
  await page.goto(EXIT_URL);

  const banner = page.getByRole("status").filter({ hasText: "Your property setup isn't complete" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
    "href",
    `/setup?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard&propertyId=${encodeURIComponent(BOOKING_ADMIN_PROPERTY_ID)}`,
  );
  // The marker leaves the URL, so a reload or a hotel switch doesn't keep pointing at this hotel.
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.screenshot({ path: testInfo.outputPath("dashboard-resume-setup.png") });
});

test("no banner after Finish for now when setup is complete", async ({ page }) => {
  await mockSetupStatus(page, false);
  await page.goto(EXIT_URL);
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
});

test("the dashboard shows no resume banner on a normal visit", async ({ page }) => {
  await mockSetupStatus(page, true);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
});
