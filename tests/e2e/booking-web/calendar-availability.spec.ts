import { expect, test } from "@playwright/test";

import { legacyPricingRequests, mockBookingApis } from "../support/bookingMocks";

// The retired public calendar used to grey out every date once it failed; the date
// picker no longer asks it anything, so future dates stay selectable and the stay is
// priced on the room-and-price page.
test("keeps future dates selectable without the retired calendar", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2028-03-05T12:00:00Z"));
  await mockBookingApis(page);
  const legacyRequests = legacyPricingRequests(page);

  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Your Stay" }).click();

  await expect(page.getByText("Select your dates")).toBeVisible();
  await expect(
    page.getByText("Availability is temporarily unavailable for these dates."),
  ).toHaveCount(0);
  await expect(page.locator('button[title="Availability unavailable"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "2028-03-04", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "2028-03-10", exact: true }).click();
  await page.getByRole("button", { name: "2028-03-13", exact: true }).click();
  await expect(page.getByText("Select your dates")).toBeHidden();
  await expect(page.getByRole("link", { name: "Choose rooms and get a price" })).toHaveAttribute(
    "href",
    "/en/book?checkIn=2028-03-10&checkOut=2028-03-13&adults=2",
  );
  expect(legacyRequests).toEqual([]);
});
