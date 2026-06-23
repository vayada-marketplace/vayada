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

  test("keeps the mobile room detail modal open for internal controls", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);

    await page.goto("/");
    await page.getByRole("button", { name: "View Details", exact: true }).click();

    const modal = page.getByRole("dialog", { name: "Alpine Suite" });
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: "Next image" }).click();
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: /View Full Amenities/i }).click();
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: "Zoom in" }).click();
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: /Select This Rate/i }).click();
    await expect(page).toHaveURL(/\/book\?/);

    await assertHealthy();
  });
});
