import { expect, test, type Page } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";
import { liveChecklistFacts, mockSetupChecklist } from "../support/setupChecklistMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

// VAY-2247 wave 2: the setup checklist on the Booking Admin dashboard, shown only where the server offers it.
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
        taskOverrides: {
          rooms_rates_availability: {
            ownerProgress: "in_progress",
            readiness: "actionable",
            actionableBy: "owner",
            reasonCodes: ["rooms_missing"],
          },
        },
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

test("shows the shared checklist under the booking page card (c02-0)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const writes = await mockSetupChecklist(page, liveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID));
  await page.goto("/dashboard");

  const status = page.getByRole("region", { name: "Your booking page", exact: true });
  const card = page.getByRole("region", { name: "Finish setting up Hotel Alpenrose" });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Same checklist in the PMS and Booking Admin. Progress is shared."),
  ).toBeVisible();
  await expect(card.getByText("4 of 9 done").filter({ visible: true })).toBeVisible();
  // Under the booking page card, as on the board.
  const [statusBox, cardBox] = [await status.boundingBox(), await card.boundingBox()];
  expect(cardBox!.y).toBeGreaterThan(statusBox!.y + statusBox!.height);
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-checklist-d.png") });

  // Guest terms' Looks good is the second one.
  await card.getByRole("button", { name: "Looks good" }).nth(1).click();
  await expect(page.getByText("Guest terms confirmed — your defaults stay.")).toBeVisible();
  await expect(card.getByText("5 of 9 done").filter({ visible: true })).toBeVisible();

  await card.getByRole("button", { name: "Hide for now" }).click();
  await expect(card).toHaveCount(0);
  const pill = page.getByRole("button", { name: "Setup 5 of 9" });
  await expect(pill).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-checklist-hidden-d.png") });
  await pill.click();
  await expect(card).toBeVisible();

  expect(
    writes.map(({ method, path, body }) => [method, path.split("/checklist")[1], body]),
  ).toEqual([
    ["POST", "/acknowledgements", { item: "guest_terms" }],
    ["PUT", "/viewer", { hidden: true }],
    ["PUT", "/viewer", { hidden: false }],
  ]);

  await assertHealthy();
  await card.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page).toHaveURL(/\/design-studio$/);
});

test("replaces the resume banner after Exit setup, and continues setup here (c01-0)", async ({
  page,
}) => {
  await mockUnfinishedSetup(page);
  await mockSetupChecklist(page, {
    ...liveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID),
    nextSetupStep: "guest_payment",
    guestPayment: false,
    bookingPublished: false,
  });
  await page.goto(EXIT_URL);

  const card = page.getByRole("region", { name: "Your booking page isn't live yet" });
  await expect(card).toBeVisible();
  await expect(page.getByText("Your property setup isn't complete")).toHaveCount(0);
  await card.getByRole("button", { name: "Continue setup" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/setup\\?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard&propertyId=${BOOKING_ADMIN_PROPERTY_ID}$`,
    ),
  );
});

test("lays the checklist out for phones (c02-0m)", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 2400 });
  await mockSetupChecklist(page, liveChecklistFacts(BOOKING_ADMIN_PROPERTY_ID));
  await page.goto("/dashboard");
  await expect(
    page.getByRole("region", { name: "Finish setting up Hotel Alpenrose" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ba-dashboard-checklist-m.png") });
});
