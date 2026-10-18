import { expect, test } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("a hotel that left setup lands on the dashboard with a way back (VAY-2249)", async ({
  page,
}, testInfo) => {
  await page.goto(`/dashboard?setup=incomplete&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`);

  const banner = page.getByRole("status").filter({ hasText: "Your property setup isn't complete" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
    "href",
    `/setup?entryProduct=booking&returnTo=%2Fdashboard&propertyId=${encodeURIComponent(BOOKING_ADMIN_PROPERTY_ID)}`,
  );
  await page.screenshot({ path: testInfo.outputPath("dashboard-resume-setup.png") });
});

test("the dashboard shows no resume banner on a normal visit", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
});
