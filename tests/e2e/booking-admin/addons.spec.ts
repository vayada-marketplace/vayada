import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin add-ons settings cutover", () => {
  test("loads and saves display settings through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await mockBookingAdminBookingFlow(page);

    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: false },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Add-ons$/ }).click();

    await expect(page.getByRole("heading", { name: "Display Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Show Add-ons Step/ })).toBeVisible();

    const groupToggle = page.getByRole("button", { name: /Group by Category/ });
    await expect(groupToggle).toBeVisible();
    await groupToggle.click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_ADDON_SETTINGS_PATH);
    expect(typedWrites).toEqual([{ showAddonsStep: true, groupAddonsByCategory: true }]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
