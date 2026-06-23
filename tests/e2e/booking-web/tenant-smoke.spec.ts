import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-web tenant smoke", () => {
  test("renders the seeded tenant from the request host", async ({ page, baseURL }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto("/");

    expect(new URL(baseURL ?? page.url()).hostname.split(".")[0]).toBe(SEEDED_BOOKING_SLUG);
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Check Availability/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Available Accommodations/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite")).toBeVisible();
    await expect(page.getByRole("button", { name: /Select This Rate/i }).first()).toBeVisible();

    await assertHealthy();
  });

  test("mobile checkout hides the hero, uses one compact summary, and allows optional phone", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page, { paymentSettings: { phoneRequired: false } });

    await page.goto(
      "/book?room=alpine-suite&checkIn=2026-07-01&checkOut=2026-07-03&adults=2&rooms=1&rateType=flexible",
    );

    await expect(page.getByRole("heading", { name: "Guest Information" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Booking Summary/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Stay" })).toBeHidden();
    await expect(page.getByLabel(/first name/i)).toBeInViewport();
    await expect(page.getByText("Phone Number (optional)")).toBeVisible();
    await assertHealthy();

    await page.getByLabel(/first name/i).fill("Ada");
    await page.getByLabel(/last name/i).fill("Lovelace");
    await page.getByLabel(/email address/i).fill("ada@example.com");
    await page.getByRole("button", { name: /continue to payment/i }).click();

    await expect(page).toHaveURL(/\/payment/);
    await expect(page.getByRole("heading", { name: "Secure Payment" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Booking Summary/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Order Summary" })).toBeHidden();
  });
});
