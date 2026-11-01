import { expect, test } from "@playwright/test";

import {
  mockBookingApis,
  mockPricingCatalogue,
  SEEDED_BOOKING_SLUG,
} from "../support/bookingMocks";
import { mockAnyPrice } from "../support/bookFlow";
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

  test("carries an applied code through a room card to /book", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await mockPricingCatalogue(page);
    await mockAnyPrice(page);
    await page.route(`**${promoPath}`, (route) =>
      route.fulfill({
        json: {
          valid: true,
          code: "SUMMER20",
          discountType: "percentage",
          discountValue: 20,
          currency: "EUR",
          message: "Promo code applied successfully.",
        },
      }),
    );

    await page.goto("/?checkIn=2026-09-12&checkOut=2026-09-15");
    await page.getByRole("button", { name: "Add promo" }).click();
    await page.getByPlaceholder("Enter code").fill("summer20");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("SUMMER20 (-20%)")).toBeVisible();
    // VAY-2446: the room card hands the code over with its choice, and /book prices with it.
    const priced = page.waitForRequest((request) => request.url().endsWith("/bookings/quote"));
    await page.getByTestId("select-rate-suite").click();

    await expect(page).toHaveURL(/\/(en\/)?book\?.*promoCode=SUMMER20.*&offer=/);
    expect((await priced).postDataJSON().selection.promoCode).toBe("SUMMER20");
    await assertHealthy();
  });

  test("hides the promo field while the hotel has Promos off (VAY-2200)", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page, { promoCodes: false });
    await mockPricingCatalogue(page);
    await mockAnyPrice(page);

    await page.goto("/?checkIn=2026-09-12&checkOut=2026-09-15");
    await expect(page.getByTestId("room-card-suite")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add promo" })).toHaveCount(0);

    // A code from an old link is left out of /book's quote request.
    const priced = page.waitForRequest((request) => request.url().endsWith("/bookings/quote"));
    await page.goto(
      `/book?checkIn=2026-09-12&checkOut=2026-09-15&adults=2&promoCode=SUMMER20&offer=pricing-offer.v2:${"a".repeat(64)}`,
    );
    expect((await priced).postDataJSON().selection.promoCode ?? "").toBe("");
    await assertHealthy();
  });
});
