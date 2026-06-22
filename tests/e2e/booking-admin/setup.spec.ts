import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin setup no-legacy guard", () => {
  test("hydrates manual setup without migrated helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-setup");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    await page.goto("/setup?mode=add");
    await page.getByRole("button", { name: "Set up manually" }).click();

    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
