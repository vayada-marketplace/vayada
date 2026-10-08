import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

const promoPath = `/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/promo/validate`;

test.describe("booking-web promo validation", () => {
  test("shows the specific rule failure returned by the canonical API", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.route(`**${promoPath}`, (route) =>
      route.fulfill({
        json: {
          valid: false,
          code: "SUMMER20",
          message: "This promo code is not available for the selected room.",
        },
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Add promo" }).click();
    await page.getByPlaceholder("Enter code").fill("summer20");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(
      page.getByText("This promo code is not available for the selected room."),
    ).toBeVisible();
    await assertHealthy();
  });
});
