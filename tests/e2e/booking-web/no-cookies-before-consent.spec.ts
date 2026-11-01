import { expect, test } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";

// VAY-2223: the booking site stores no cookie before the guest's privacy choice, also when the
// guest arrives through a partner's referral link. The choice itself lives in local storage.
test("sets no cookie before or after the privacy choice", async ({ page, context }) => {
  await mockBookingApis(page);

  await page.goto("/?ref=PARTNER-2223&checkIn=2026-09-12&checkOut=2026-09-15");
  await expect(
    page.getByRole("heading", { name: "Optional analytics", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
  // A retired booking page's permanent redirect (to the hotel page since VAY-2446) drops the old
  // referral code too (VAY-2302).
  await page.goto("/rooms?ref=PARTNER-2223&checkIn=2026-09-12&checkOut=2026-09-15");
  await expect(page).toHaveURL(/\/(en\/)?\?checkIn=2026-09-12&checkOut=2026-09-15$/);
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
  expect(await context.cookies()).toEqual([]);

  // The prompt opens again on this full page load: no choice was made yet.
  await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
  expect(await context.cookies()).toEqual([]);
});
