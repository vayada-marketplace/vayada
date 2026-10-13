import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

// VAY-2153: the hotel loading and error screens live in contexts/HotelContext.tsx. When
// Tailwind did not scan contexts/, the spinner lost its dark segment (a plain grey
// ring) and the error detail lost break-all.
test("shows a spinning segment while the hotel loads and wraps the error detail", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page);
  let releaseHotel!: () => void;
  const hotelHeld = new Promise<void>((resolve) => {
    releaseHotel = resolve;
  });
  await page.route(
    new RegExp(`/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}(?:\\?.*)?$`),
    async (route) => {
      await hotelHeld;
      await route.fulfill({ status: 503, json: { detail: "Hotel profile unavailable" } });
    },
  );

  await page.goto("/");
  const spinner = page.locator(".animate-spin");
  await expect(spinner).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hotel-loading.png") });
  const border = await spinner.evaluate((element) => {
    const style = getComputedStyle(element);
    return { top: style.borderTopColor, bottom: style.borderBottomColor };
  });
  expect(border.top, "the spinner's moving segment differs from its ring").not.toBe(border.bottom);

  releaseHotel();
  const heading = page.getByRole("heading", { name: "Unable to Load Hotel" });
  await expect(heading).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("hotel-error.png") });
  const detail = heading.locator("..").locator("p.font-mono");
  await expect(detail).toBeVisible();
  expect(await detail.evaluate((element) => getComputedStyle(element).wordBreak)).toBe("break-all");
});
