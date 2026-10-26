import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_BENEFITS_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin benefits settings cutover", () => {
  test("loads and saves benefits through the TypeScript contract", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "booking-admin-benefits-settings",
    );

    await mockBookingAdminBookingFlow(page);

    const typedBenefits = ["Welcome Drink on Arrival", "Complimentary sunset cocktail"];
    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    let failFirstRead = true;
    await page.route(`**${BOOKING_ADMIN_BENEFITS_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      if (failFirstRead) {
        failFirstRead = false;
        await route.fulfill({ status: 503, json: { message: "Benefits unavailable." } });
        return;
      }
      await route.fulfill({ json: { benefits: typedBenefits } });
    });

    // Benefits moved from Booking Flow to Settings (VAY-2072); old tab links still land there.
    await page.goto("/booking-flow?tab=benefits");
    await expect(page).toHaveURL(/\/settings\/book-direct-benefits$/);
    await expect(page.getByRole("heading", { name: "Book Direct Benefits" })).toBeVisible();
    // A failed read shows Retry, never an empty list that a Save would write over the perks.
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to load settings" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save Benefits$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    // Watch page health only after the deliberate 503 above.
    const assertHealthy = watchPageHealth(page, testInfo);
    await expect(page.getByText("Complimentary sunset cocktail")).toBeVisible();
    await testInfo.attach("settings-book-direct-benefits", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: /^Save Benefits$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_BENEFITS_SETTINGS_PATH);
    expect(typedWrites).toEqual([{ benefits: typedBenefits }]);
    await expect(page.getByRole("status").filter({ hasText: "Benefits saved" })).toBeVisible();

    await page.goto("/settings");
    await page
      .getByRole("main")
      .getByRole("link", { name: /^Book Direct Benefits/ })
      .click();
    await expect(page).toHaveURL(/\/settings\/book-direct-benefits$/);
    await page.goto("/booking-flow");
    await expect(page.getByRole("button", { name: /^Benefits$/ })).toHaveCount(0);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
