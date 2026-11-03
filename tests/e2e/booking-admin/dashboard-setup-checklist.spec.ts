import { expect, test, type Page } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";
import { goLiveChecklistFacts, mockSetupChecklist } from "../support/setupChecklistMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

// VAY-2247 wave 2, VAY-2451: the go-live cards on the Booking Admin dashboard, shown only where the server
// offers them.
const EXIT_URL = `/dashboard?setup=incomplete&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`;

async function mockUnfinishedSetup(page: Page) {
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
  await page.setViewportSize({ width: 1440, height: 1400 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page, {
    propertySettings: { ...defaultBookingAdminPropertySettings, property_name: "Hotel Alpenrose" },
  });
});

test("keeps today's dashboard while the checklist API isn't mounted (404)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockUnfinishedSetup(page);
  await page.goto(EXIT_URL);

  const banner = page.getByRole("status").filter({ hasText: "Your property setup isn't complete" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Resume setup" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your booking page", exact: true })).toBeVisible();
  await expect(page.getByText(/Finish setting up/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-checklist-unavailable.png") });
  await assertHealthy();
});

test("shows the go-live list under the booking page card", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockSetupChecklist(page, goLiveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID));
  await page.goto("/dashboard");

  const status = page.getByRole("region", { name: "Your booking page", exact: true });
  const card = page.getByRole("region", { name: "Get ready to go live" });
  await expect(card).toBeVisible();
  await expect(card.getByText("3 of 6 done")).toBeVisible();
  await expect(page.getByRole("region", { name: "Later, when you're ready" })).toBeVisible();
  // Under the booking page card, as in the mockup.
  const [statusBox, cardBox] = [await status.boundingBox(), await card.boundingBox()];
  expect(cardBox!.y).toBeGreaterThan(statusBox!.y + statusBox!.height);
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-go-live-d.png") });
  await assertHealthy();

  // Reviewing the booking rules counts as "Looks good", then opens the policies.
  await card.getByRole("button", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/settings\/policies$/);
  expect(
    writes.map(({ method, path, body }) => [method, path.split("/checklist")[1], body]),
  ).toEqual([["POST", "/v2/acknowledgements", { item: "guest_terms" }]]);
});

test("replaces the resume banner after Exit setup, and continues setup here", async ({ page }) => {
  await mockUnfinishedSetup(page);
  await mockSetupChecklist(page, {
    ...goLiveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID),
    setupFinished: false,
  });
  await page.goto(EXIT_URL);

  const card = page.getByRole("region", { name: "Finish setting up Hotel Alpenrose" });
  await expect(card).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
  await card.getByRole("button", { name: "Continue setup" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/setup\\?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard&propertyId=${BOOKING_ADMIN_PROPERTY_ID}$`,
    ),
  );
});

test("a live hotel's card says so, and Dismiss keeps it away", async ({ page }) => {
  const writes = await mockSetupChecklist(page, {
    ...goLiveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID),
    bookingRules: "acknowledged",
    bookingPublished: true,
  });
  await page.goto("/dashboard");

  const card = page.getByRole("region", { name: "Your booking page is live" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  expect(
    writes.map(({ method, path, body }) => [method, path.split("/checklist")[1], body]),
  ).toEqual([["PUT", "/v2/viewer", { dismissed: true }]]);
});

test("lays the go-live list out for phones", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 2400 });
  await mockSetupChecklist(page, goLiveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID));
  await page.goto("/dashboard");
  await expect(page.getByRole("region", { name: "Get ready to go live" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-go-live-m.png") });
});

test("speaks the admin's language (German)", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("admin_language", "de"));
  await mockSetupChecklist(page, goLiveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID));
  await page.goto("/dashboard");

  const card = page.getByRole("region", { name: "Livegang vorbereiten" });
  await expect(card).toBeVisible();
  await expect(card.getByText("3 von 6 erledigt")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-go-live-de-d.png") });
});
