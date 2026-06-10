import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_BENEFITS_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin benefits settings cutover", () => {
  test("loads and saves benefits through the TypeScript contract", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);

    await mockBookingAdminBookingFlow(page);

    const typedBenefits = ["Welcome Drink on Arrival", "Complimentary sunset cocktail"];
    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_BENEFITS_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: { benefits: typedBenefits } });
    });

    const legacyWrites: unknown[] = [];
    await page.route("**/admin/benefits", async (route) => {
      if (route.request().method() === "PUT") {
        legacyWrites.push(route.request().postDataJSON());
        await route.fulfill({ json: { benefits: typedBenefits } });
        return;
      }

      await route.fulfill({ json: { benefits: [] } });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Benefits$/ }).click();

    await expect(page.getByRole("heading", { name: "Book Direct Benefits" })).toBeVisible();
    await expect(page.getByText("Complimentary sunset cocktail")).toBeVisible();

    await page.getByRole("button", { name: /^Save Benefits$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_BENEFITS_SETTINGS_PATH);
    expect(typedWrites).toEqual([{ benefits: typedBenefits }]);
    expect(legacyWrites).toEqual([]);

    await assertHealthy();
  });
});
