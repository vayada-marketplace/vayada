import { expect, test, type Page } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

async function mockTracking(page: Page, trackingMissing: boolean) {
  let reads = 0;
  await page.route("**/api/booking/properties/*/dashboard/tracking**", (route) => {
    reads += 1;
    return route.fulfill({
      json: {
        tracking: {
          propertyId: "property-1",
          bookingPageBookingCount: trackingMissing ? 3 : 0,
          pageViewCount: 0,
          trackingMissing,
        },
      },
    });
  });
  return () => reads;
}

const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Page view tracking not detected." });

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("bookings on the booking page without page views show the amber banner (VAY-2594)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reads = await mockTracking(page, true);
  await page.goto("/dashboard");
  const line = banner(page);
  await expect(line).toBeVisible();
  await expect(line).toContainText(
    "Bookings are recorded, but visitors and conversion may be incomplete.",
  );
  await expect(line).toHaveCSS("background-color", "rgb(255, 250, 235)");
  const link = line.getByRole("link", { name: "Check setup →" });
  await expect(link).toHaveAttribute("href", "/design-studio?tab=domain");
  // Above the cards, under the page's header.
  const bannerBox = (await line.boundingBox())!;
  const cardBox = (await page
    .getByRole("button", { name: "Open revenue details" })
    .first()
    .boundingBox())!;
  expect(bannerBox.y).toBeLessThan(cardBox.y);
  // Read once per visit, not per range: the 90 days' chart is read, the check isn't again.
  const before = reads();
  const quarter = page.waitForRequest("**/dashboard/revenue-days**");
  await page
    .getByRole("group", { name: "Date range" })
    .getByRole("button", { name: "90 days" })
    .click();
  await quarter;
  await expect(line).toBeVisible();
  expect(reads()).toBe(before);
  await line.screenshot({ path: testInfo.outputPath("tracking-banner-1440.png") });
});

test("no banner while page views are counted, nor when the check fails", async ({ page }) => {
  await mockTracking(page, false);
  const answered = page.waitForResponse("**/dashboard/tracking**");
  await page.goto("/dashboard");
  await answered;
  await expect(page.getByRole("heading", { name: "Revenue over time" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  await page.unroute("**/api/booking/properties/*/dashboard/tracking**");
  await page.route("**/api/booking/properties/*/dashboard/tracking**", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  const failed = page.waitForResponse("**/dashboard/tracking**");
  await page.reload();
  await failed;
  await expect(page.getByRole("heading", { name: "Revenue over time" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test("on a small phone the banner wraps without scrolling sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 1200 });
  await mockTracking(page, true);
  await page.goto("/dashboard");
  const line = banner(page);
  await expect(line).toBeVisible();
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  const link = (await line.getByRole("link").boundingBox())!;
  const box = (await line.boundingBox())!;
  expect(link.x + link.width).toBeLessThanOrEqual(box.x + box.width);
  // The link goes under the text rather than squeezing it into a narrow column.
  const text = (await line.locator("p").boundingBox())!;
  expect(link.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
  expect(text.width).toBeGreaterThan(200);
  await line.screenshot({ path: testInfo.outputPath("tracking-banner-360.png") });
});
