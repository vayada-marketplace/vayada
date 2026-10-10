import { expect, test } from "@playwright/test";
import {
  legacyPricingRequests,
  mockBookingApis,
  mockPricingCatalogue,
} from "../support/bookingMocks";

// The legacy availability search (GET /offers) is retired: the hotel page no longer
// claims anything about capacity or availability. It hands the chosen stay and party to
// the room-and-price page, which prices rooms and guests itself.
for (const mobile of [false, true]) {
  test(`hands the chosen stay to the room-and-price page without the retired search (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);
    await mockPricingCatalogue(page);
    const legacyRequests = legacyPricingRequests(page);
    await page.goto("/?adults=13&children=1&checkIn=2026-09-12&checkOut=2026-09-15");
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
    await expect(page.getByRole("button").filter({ hasText: "13 adults" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Unable to Load Hotel" })).toHaveCount(0);
    const entry = page.getByRole("link", { name: "Choose rooms and get a price" });
    await expect(entry).toHaveAttribute(
      "href",
      /^\/(en\/)?book\?checkIn=2026-09-12&checkOut=2026-09-15&adults=13&children=1$/,
    );
    await page.screenshot({ path: test.info().outputPath("guest-capacity.png"), fullPage: true });
    await page.getByRole("button", { name: "Check Availability", exact: true }).click();
    await expect(page).toHaveURL(
      /\/(en\/)?book\?checkIn=2026-09-12&checkOut=2026-09-15&adults=13&children=1$/,
    );
    const room = page.getByRole("group", { name: "Room 1" });
    await expect(room.getByRole("spinbutton", { name: /Adults/ })).toHaveValue("13");
    await expect(room.getByRole("combobox", { name: /Child 1/ })).toHaveValue("");
    await expect(page.getByRole("group", { name: "Room 2" })).toHaveCount(0);
    expect(legacyRequests).toEqual([]);
  });
}
