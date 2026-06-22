import { expect, test } from "@playwright/test";

import { watchNoLegacyCalls } from "../support/noLegacyCalls";

test.describe("booking-admin no-legacy-call guard", () => {
  test("names the offending legacy host request", async ({ page }, testInfo) => {
    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "booking-admin-benefits-settings",
    );

    await page.route("https://api.vayada.com/**", (route) => route.fulfill({ body: "ok" }));
    await page.evaluate(() => fetch("https://api.vayada.com/legacy"));

    await expect(assertNoLegacyCalls()).rejects.toThrow(
      "legacy production API host: GET https://api.vayada.com/legacy",
    );
  });

  test("names the offending legacy header request", async ({ page }, testInfo) => {
    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "booking-admin-benefits-settings",
    );

    await page.route("https://admin.booking.localhost/**", (route) =>
      route.fulfill({ body: "<html></html>", contentType: "text/html" }),
    );
    await page.goto("https://admin.booking.localhost/");
    await page.evaluate(() =>
      fetch("/api/booking/hotels/booking_hotel_alpenrose/settings/benefits", {
        headers: { "X-Hotel-Id": "booking_hotel_alpenrose" },
      }),
    );

    await expect(assertNoLegacyCalls()).rejects.toThrow(
      "legacy X-Hotel-Id routing header: GET https://admin.booking.localhost/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
    );
  });

  test("names migrated booking-flow helper routes", async ({ page }, testInfo) => {
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await page.route("https://admin.booking.localhost/**", (route) =>
      route.fulfill({ body: "[]", contentType: "application/json" }),
    );
    await page.goto("https://admin.booking.localhost/");
    await page.evaluate(() => fetch("/admin/addons"));

    await expect(assertNoLegacyCalls()).rejects.toThrow(
      "legacy Booking Admin add-on item route: GET https://admin.booking.localhost/admin/addons",
    );
  });

  test("names migrated booking-flow hotel settings route", async ({ page }, testInfo) => {
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await page.route("https://admin.booking.localhost/**", (route) =>
      route.fulfill({ body: "{}", contentType: "application/json" }),
    );
    await page.goto("https://admin.booking.localhost/");
    await page.evaluate(() => fetch("/admin/hotel"));

    await expect(assertNoLegacyCalls()).rejects.toThrow(
      "legacy Booking Admin hotel settings route: GET https://admin.booking.localhost/admin/hotel",
    );
  });
});
