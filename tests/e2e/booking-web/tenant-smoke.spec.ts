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
});
