import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice } from "../support/bookFlow";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2495: the checkout on a phone: a 56px bar with the property's name and a back arrow (no
// Contact, language or currency), "Step 2 of 3 · Your details" with a thin progress bar, the stay in
// a small card, the form without a card, and "Your stay" as one slim row whose "Details" opens a
// sheet. Wide screens keep the old frame.
const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;
const STAY = `/book?checkIn=2026-12-11&checkOut=2026-12-12&adults=2&offer=${offerKey}`;
const addon = "55555555-5555-4555-8555-555555555555";
const BRAND = "#c19a76";

async function mockCheckout(page: Page, { extras = false } = {}) {
  // The analytics question is answered, so nothing covers the step.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await mockBookingApis(page, { primaryColor: BRAND, hotelName: "Aether Hilltop Villas" });
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: extras ? [{ id: addon, description: "", price: 25, category: "other" }] : [],
        payAtPropertyEnabled: true,
        bookingPagePaymentMethods: ["pay_at_property", "card"],
        termsText: "Quiet hours are 22:00–07:00.",
      },
    }),
  );
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "villa-five",
            name: "Villa Five",
            images: [{ url: "/vayada-logo.png", alt: "Villa Five" }],
            offers: [{ publicOfferKey: offerKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-addons.v1",
        addons: extras
          ? [
              {
                id: addon,
                name: "Airport transfer",
                currency: "EUR",
                pricingModel: "per_stay",
                maxQuantity: 1,
                maxGuests: null,
                scheduleMode: "anytime",
                bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
              },
            ]
          : [],
      },
    }),
  );
  await mockAnyPrice(page);
}

const phone = { width: 390, height: 844 };
const box = async (page: Page, locator: ReturnType<Page["locator"]>) =>
  (await locator.boundingBox())!;

test("fits the details step on a phone's first screen, with the slim bar", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=details/);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");

  // The checkout's own bar: back arrow and name, no Contact, language or currency.
  const header = page.getByRole("banner");
  await expect(header).toContainText("Aether Hilltop Villas");
  expect(Math.round((await box(page, header.locator(":scope > div").first())).height)).toBe(56);
  await expect(header.getByRole("button", { name: "Back to rooms" })).toBeVisible();
  await expect(page.getByRole("navigation")).toBeHidden();
  for (const name of ["Contact", "EN", "EUR"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  // "Step 2 of 3 · Your details" instead of the title and the step circles.
  await expect(header).toContainText("Step 2 of 3 ·Your details");
  await expect(page.getByRole("heading", { name: "Your details", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rooms", exact: true })).toBeHidden();

  // The stay in a small card; "Who's staying?" is the only heading of the form.
  const brief = page.getByTestId("stay-brief");
  await expect(brief).toContainText("Villa Five · Room only");
  await expect(brief).toContainText("1 night · 2 adults");
  await expect(page.getByRole("heading", { name: "Who’s staying?" })).toBeVisible();

  // One row: the total, how the guest pays and Details beside a "Continue" button.
  const bar = await box(page, stay);
  expect(bar.height).toBeLessThanOrEqual(phone.height * 0.1);
  await expect(stay).toContainText("Pay at the hotel ·");
  const next = stay.getByRole("button", { name: "Continue to review" });
  await expect(next).toHaveText("Continue", { useInnerText: true });
  await expect(next).toBeVisible();
  expect((await box(page, next)).y).toBeGreaterThan(bar.y);
  await expect(stay.getByText("Pay now")).toBeHidden();

  // Every required field on the first screen, above the bar; first and last name side by side.
  for (const field of [
    page.getByLabel("First name"),
    page.getByLabel("Last name"),
    page.getByLabel("Email", { exact: true }),
    page.getByRole("textbox", { name: "Phone" }),
  ]) {
    const { y, height } = await box(page, field);
    expect(y + height).toBeLessThanOrEqual(bar.y);
  }
  const first = await box(page, page.getByLabel("First name"));
  const last = await box(page, page.getByLabel("Last name"));
  expect(last.y).toBe(first.y);
  // The code field is narrow: "+49", the number takes the rest.
  expect((await box(page, page.getByLabel("Country code"))).width).toBeLessThanOrEqual(90);
  await page.screenshot({ path: testInfo.outputPath("details-390-first-screen.png") });

  await fillGuestDetails(page);
  await next.click();
  await expect(page).toHaveURL(/[?&]step=payment/);
  await assertHealthy();
});

test("opens the price sheet from Details, and Escape or Close shuts it", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");
  const details = stay.getByRole("button", { name: "Details", exact: true });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await details.click();
  // The breakdown, the payment lines, the cancellation policy and the button.
  await expect(stay.getByText("1 night")).toBeVisible();
  await expect(stay.getByText("Includes taxes & fees")).toBeVisible();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await expect(stay.getByText("At the hotel")).toBeVisible();
  await expect(stay.getByRole("button", { name: /^Cancellation policy/ })).toBeVisible();
  await expect(stay.getByRole("button", { name: "Continue to review" })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("details-390-sheet.png") });
  await page.keyboard.press("Escape");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(details).toBeFocused();
  await expect(stay.getByText("Pay now")).toBeHidden();
  await details.click();
  await stay.getByRole("button", { name: "Close" }).click();
  await expect(stay.getByText("Pay now")).toBeHidden();
});

test("Continue in the open sheet with fields missing closes it and marks the first field", async ({
  page,
}) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");
  const details = stay.getByRole("button", { name: "Details", exact: true });
  await details.click();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await stay.getByRole("button", { name: "Continue to review" }).click();
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("First name")).toBeFocused();
  await expect(page.getByLabel("First name")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/[?&]step=details/);
});

test("keeps the brand-colour footer clear of the bar, white text on the brand colour", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(async () => {
      const footer = await box(page, page.locator("footer"));
      return Math.round(footer.y + footer.height) <= Math.round((await box(page, stay)).y);
    })
    .toBe(true);
  const white = "rgb(255, 255, 255)";
  await expect(page.locator("footer h3")).toHaveCSS("color", white);
  await expect(stay.getByRole("button", { name: "Continue to review" })).toHaveCSS("color", white);
  await page.screenshot({ path: testInfo.outputPath("details-390-end.png") });
});

test("Edit in the stay's card goes back to the rooms", async ({ page }) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Edit your stay" }).click();
  await expect(page).toHaveURL(/\/\?checkIn=2026-12-11&checkOut=2026-12-12&adults=2$/);
});

test("Extras has the slim bar too; Review keeps its full bar under the new header", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(phone);
  await mockCheckout(page, { extras: true });
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=extras/);
  const header = page.getByRole("banner");
  await expect(header).toContainText("Step 2 of 4 ·Enhance Your Stay");
  const stay = page.getByRole("complementary", { name: "Your stay" });
  const skip = stay.getByRole("button", { name: "Continue without extras" });
  await expect(skip).toHaveText("Continue", { useInnerText: true });
  expect((await box(page, stay)).height).toBeLessThanOrEqual(phone.height * 0.1);
  await skip.click();
  await expect(header).toContainText("Step 3 of 4 ·Your details");
  await expect(header.getByRole("button", { name: "Back to extras" })).toBeVisible();
  await fillGuestDetails(page);
  await stay.getByRole("button", { name: "Continue to review" }).click();
  await expect(header).toContainText("Step 4 of 4 ·Review & pay");
  // Review: the tick, the payment lines and Confirm stay in the bar.
  await expect(stay.getByLabel(/I agree to the cancellation policy/)).toBeVisible();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await expect(stay.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-390.png") });
  await header.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(/[?&]step=details/);
});

test("a wide screen keeps the hotel's bar, the title and the step circles", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockCheckout(page);
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=details/);
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Contact", exact: true })).toBeVisible();
  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Your details", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to rooms" })).toBeVisible();
  await expect(page.getByTestId("stay-brief")).toBeHidden();
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByText("Total", { exact: true })).toBeVisible();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await expect(stay.getByRole("button", { name: "Continue to review" })).toHaveText(
    "Continue to review",
    { useInnerText: true },
  );
});
