import { expect, test } from "@playwright/test";
import { mockBookingApis, mockPricingCatalogue } from "../support/bookingMocks";

// The retired room list, add-on and payment pages answer a server redirect, so clients
// without JavaScript (crawlers, link checkers) see it as well as browsers do.
test("answers a permanent redirect to the room-and-price page", async ({ page }) => {
  for (const [path, target] of [
    [
      "/en/rooms?checkIn=2026-09-12&checkOut=2026-09-15&room=alpine-suite",
      "/book?checkIn=2026-09-12&checkOut=2026-09-15",
    ],
    ["/de/payment?adults=3", "/de/book?adults=3"],
    ["/addons", "/book"],
  ]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(308);
    const location = new URL(response.headers()["location"]!);
    expect(location.pathname + location.search, path).toBe(target);
  }

  await mockBookingApis(page);
  await mockPricingCatalogue(page);
  await page.goto("/payment?checkIn=2026-09-12&checkOut=2026-09-15&adults=2");
  await expect(page).toHaveURL(/\/book\?checkIn=2026-09-12&checkOut=2026-09-15&adults=2$/);
  await expect(
    page.getByRole("group", { name: "Room 1" }).getByRole("spinbutton", { name: /Adults/ }),
  ).toHaveValue("2");
});
