import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin settings no-legacy guard", () => {
  test("loads migrated settings surfaces without helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**/api/pms/properties/${BOOKING_ADMIN_HOTEL_ID}/payment-settings*`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentProvider: "vayada",
            payAtPropertyEnabled: true,
            onlineCardPayment: false,
            bankTransfer: false,
          },
        },
      }),
    );

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Booking", exact: true }).click();
    await expect(
      page.getByText("Custom domain management is not available on next-api yet."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Location map", exact: true }).click();
    await expect(
      page.getByText("Automatic property map centering is not available on next-api yet."),
    ).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
