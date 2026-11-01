import { expect, test } from "@playwright/test";
import { mockBookingApis, mockPricingCatalogue } from "../support/bookingMocks";

// The retired room list, add-on and payment pages answer a server redirect, so clients
// without JavaScript (crawlers, link checkers) see it as well as browsers do. VAY-2446: to the
// hotel page, where rooms are chosen.
test("answers a permanent redirect to the hotel page", async ({ page }) => {
  for (const [path, target] of [
    [
      "/en/rooms?checkIn=2026-09-12&checkOut=2026-09-15&room=alpine-suite",
      "/?checkIn=2026-09-12&checkOut=2026-09-15",
    ],
    ["/de/payment?adults=3", "/de?adults=3"],
    ["/addons", "/"],
  ]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(308);
    const location = new URL(response.headers()["location"]!);
    expect(location.pathname + location.search, path).toBe(target);
  }

  await mockBookingApis(page);
  await mockPricingCatalogue(page);
  await page.goto("/payment?checkIn=2026-09-12&checkOut=2026-09-15&adults=2");
  await expect(page).toHaveURL(/\/\?checkIn=2026-09-12&checkOut=2026-09-15&adults=2$/);
  await expect(page.getByTestId("room-card-suite")).toBeVisible();
});
