import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin last-minute settings cutover", () => {
  test("loads and saves last-minute settings through the TypeScript contract", async ({
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
    await page.route(`**${BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({
          json: {
            ...(body as object),
            updatedAt: "2026-06-22T10:00:00.000Z",
          },
        });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: {
          enabled: true,
          stackWithPromo: false,
          tiers: [{ daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 }],
          updatedAt: "2026-06-22T10:00:00.000Z",
        },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Last-Minute$/ }).click();

    await expect(page.getByRole("heading", { name: "Last-minute discounts" })).toBeVisible();
    await expect(page.locator('input[type="number"]').nth(2)).toHaveValue("30");

    await page.getByRole("button", { name: "Save Last-Minute Settings" }).click();
    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        enabled: true,
        stackWithPromo: false,
        tiers: [{ daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 }],
      },
    ]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
