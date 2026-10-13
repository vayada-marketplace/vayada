import { expect, test, type Page } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

// VAY-2153: the hotel loading and error screens live in contexts/HotelContext.tsx. When
// Tailwind did not scan contexts/, the spinner lost its dark segment (a plain grey
// ring) and the error detail lost break-all.
async function routeHotel(page: Page, handler: Parameters<Page["route"]>[1]) {
  await mockBookingApis(page);
  await page.route(
    new RegExp(`/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}(?:\\?.*)?$`),
    handler,
  );
}

test("shows a spinning segment while the hotel loads", async ({ page }, testInfo) => {
  // Never answer the hotel request, so the loading screen stays up.
  await routeHotel(page, () => new Promise<void>(() => {}));

  await page.goto("/");
  const spinner = page.locator(".animate-spin");
  await expect(spinner).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hotel-loading.png") });
  await expect
    .poll(() =>
      spinner.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.borderTopColor !== style.borderBottomColor;
      }),
    )
    .toBe(true);
});

test("wraps a long error detail when the hotel cannot load", async ({ page }, testInfo) => {
  await routeHotel(page, (route) =>
    route.fulfill({ status: 503, json: { detail: "Hotel profile unavailable" } }),
  );

  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Unable to Load Hotel" });
  await expect(heading).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hotel-error.png") });
  await expect(heading.locator("..").locator("p.font-mono")).toHaveCSS("word-break", "break-all");
});
