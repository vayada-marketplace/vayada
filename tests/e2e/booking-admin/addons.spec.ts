import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin add-ons settings cutover", () => {
  test("loads display settings from the TypeScript contract and preserves legacy writes", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

    await mockBookingAdminBookingFlow(page);

    const contractRequests: string[] = [];
    await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, async (route) => {
      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: false },
      });
    });

    const legacyWrites: string[] = [];
    await page.route("**/admin/settings/addons", async (route) => {
      legacyWrites.push(route.request().postData() ?? "");
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().postDataJSON()).toEqual({ groupAddonsByCategory: true });
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: true },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Add-ons$/ }).click();

    await expect(page.getByRole("heading", { name: "Display Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Show Add-ons Step/ })).toBeVisible();

    const groupToggle = page.getByRole("button", { name: /Group by Category/ });
    await expect(groupToggle).toBeVisible();
    await groupToggle.click();

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_ADDON_SETTINGS_PATH);
    expect(legacyWrites).toEqual([JSON.stringify({ groupAddonsByCategory: true })]);

    await assertHealthy();
  });
});
