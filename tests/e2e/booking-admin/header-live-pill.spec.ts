import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  BOOKING_PUBLICATION_PATH,
  bookingPublicationReviewMock,
  fulfillPublication,
  type BookingPublicationMockState,
} from "../support/bookingPublicationMocks";

const pill = (page: Page) =>
  page.locator("header").getByRole("button", { name: /^(Live|Offline)/ });
const popover = (page: Page) => page.getByRole("dialog", { name: "Your booking page" });

async function publication(page: Page, state: BookingPublicationMockState) {
  const review = await bookingPublicationReviewMock(BOOKING_ADMIN_PROPERTY_ID, state);
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { json: review }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("a live page's pill opens, copies its link and leads to Design Studio (VAY-2594)", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");

  // The pill replaces the Preview button.
  await expect(pill(page)).toHaveText(/^Live\s*hotel-alpenrose\.booking\.vayada\.com$/);
  await expect(page.locator("header").getByRole("button", { name: "Preview" })).toHaveCount(0);
  await expect(pill(page)).toHaveCSS("background-color", "rgb(241, 250, 244)");
  await expect(pill(page)).toHaveAttribute("aria-expanded", "false");

  await pill(page).click();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
  const box = popover(page);
  await expect(box).toContainText("Your booking page");
  await expect(box).toContainText("hotel-alpenrose.booking.vayada.com");
  await expect(box).toContainText("Changes you save go live automatically.");
  const open = box.getByRole("link", { name: "Open page" });
  await expect(open).toHaveAttribute("href", "https://hotel-alpenrose.booking.vayada.com");
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", /noopener/);
  // Right-aligned under the pill, 300px wide.
  const [pillBox, popoverBox] = [await pill(page).boundingBox(), await box.boundingBox()];
  expect(popoverBox!.width).toBe(300);
  expect(Math.abs(popoverBox!.x + popoverBox!.width - (pillBox!.x + pillBox!.width))).toBeLessThan(
    1,
  );
  expect(popoverBox!.y).toBeGreaterThan(pillBox!.y + pillBox!.height);
  await page.screenshot({ path: testInfo.outputPath("live-pill-open-1440.png") });

  await box.getByRole("button", { name: "Copy link" }).click();
  await expect(box.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://hotel-alpenrose.booking.vayada.com",
  );

  // Escape closes it and gives the focus back; opening again starts with "Copy link".
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await expect(pill(page)).toBeFocused();
  await pill(page).click();
  await expect(box.getByRole("button", { name: "Copy link" })).toBeVisible();
  // A click elsewhere closes it too.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await expect(box).toBeHidden();

  await pill(page).click();
  await box.getByRole("link", { name: "Edit in Design Studio →" }).click();
  await expect(page).toHaveURL(/\/design-studio$/);
  await expect(box).toBeHidden();
  // On every page, not only the Dashboard.
  await expect(pill(page)).toHaveText(/^Live/);
});

test("an offline page's pill is red and still opens the page's address (VAY-2594)", async ({
  page,
}, testInfo) => {
  await publication(page, "ready");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");

  await expect(pill(page)).toHaveText(/^Offline/);
  await expect(pill(page)).toHaveCSS("background-color", "rgb(254, 243, 242)");
  await pill(page).click();
  const box = popover(page);
  await expect(box).toContainText("Guests can't book right now.");
  // Where the page will be once it's live, as the old Preview button opened it.
  await expect(box.getByRole("link", { name: "Open page" })).toHaveAttribute(
    "href",
    /hotel-alpenrose/,
  );
  await page.screenshot({ path: testInfo.outputPath("offline-pill-open-1440.png") });
});

test("no pill for staff who can't see the booking page's status", async ({ page }) => {
  await page.route(BOOKING_PUBLICATION_PATH, (route) =>
    fulfillPublication(route, { status: 403, json: { code: "forbidden" } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const answered = page.waitForResponse(
    (response) =>
      BOOKING_PUBLICATION_PATH.test(response.url()) && response.request().method() === "GET",
  );
  await page.goto("/settings");
  await answered;
  await expect(page.getByRole("combobox", { name: "Search pages and settings" })).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
});

test("on a phone the pill is a dot named Live, and its popover fits", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await expect(pill(page)).toHaveText(/^Live$/, { useInnerText: true });
  await pill(page).click();
  const box = await popover(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("live-pill-open-390.png") });
});
