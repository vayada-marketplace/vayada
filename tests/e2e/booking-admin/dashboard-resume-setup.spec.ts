import { expect, test, type Page } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { corsHeaders } from "../support/cors";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

const EXIT_URL = `/dashboard?setup=incomplete&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`;

// The layout's entry guard reads the status; the banner itself doesn't (VAY-2175).
async function mockSetupStatus(page: Page) {
  await page.route("**/api/hotel-setup/status**", (route) =>
    route.fulfill({
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId: "org_hotel_group",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        propertyDisplayName: "Alpenrose",
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
  await mockSetupStatus(page);
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

// Without a status read, the banner waits for the checklist instead: it shows what's left when it
// loads, so the banner appears only once the checklist can't (VAY-2175).
test("shows the banner from the exit marker alone, once the checklist can't load (VAY-2175)", async ({
  page,
}) => {
  await mockSetupStatus(page);
  let answerChecklist = () => {};
  const checklistAsked = new Promise<void>((asked) => {
    void page.route(/\/api\/hotel-setup\/properties\/[^/]+\/checklist$/, async (route) => {
      const headers = corsHeaders(route);
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      await new Promise<void>((answer) => {
        answerChecklist = answer;
        asked();
      });
      return route.fulfill({ status: 404, headers, json: { error: "Not Found" } });
    });
  });
  await page.goto(EXIT_URL);

  await checklistAsked;
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  const banner = page.getByRole("status").filter({ hasText: "Your property setup isn't complete" });
  await expect(banner).toHaveCount(0);
  answerChecklist();
  await expect(banner).toBeVisible();
});

test("the dashboard shows no resume banner on a normal visit", async ({ page }) => {
  await mockSetupStatus(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Booking Engine" })).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
});
