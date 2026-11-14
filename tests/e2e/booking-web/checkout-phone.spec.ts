import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice } from "../support/bookFlow";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2495: the checkout on a phone: a 56px bar with the property's name and a back arrow (no
// Contact, language or currency), "Step 2 of 3 · Your details" with a thin progress bar, the stay in
// a small card, the form without a card, and "Your stay" as one slim row whose "Details" opens a
// sheet. Wide screens keep the old frame. Then Timo's boards: the bar stays at the top in the hotel's
// colour with one segment per step, the step on white with 52px fields and no asterisks, the button
// filling the row, a "Price details" sheet, and a slim brand footer.
const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;
const STAY = `/book?checkIn=2026-12-11&checkOut=2026-12-12&adults=2&offer=${offerKey}`;
const addon = "55555555-5555-4555-8555-555555555555";
const BRAND = "#c19a76";

async function mockCheckout(page: Page, { extras = false, specialRequests = false } = {}) {
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
  await mockAnyPrice(page, { specialRequests });
}

const phone = { width: 390, height: 844 };
const box = async (page: Page, locator: ReturnType<Page["locator"]>) =>
  (await locator.boundingBox())!;
// What a Tailwind brand class resolves to on the page (the palette comes from the hotel's colour).
const brandColour = (page: Page, className: string, property: "color" | "backgroundColor") =>
  page.evaluate(
    ([name, prop]) => {
      const probe = document.body.appendChild(document.createElement("span"));
      probe.className = name;
      const value = getComputedStyle(probe)[prop as "color"];
      probe.remove();
      return value;
    },
    [className, property],
  );
const WHITE = "rgb(255, 255, 255)";

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
  // (The slim footer at the end of the step has its own Contact.)
  for (const name of ["Contact", "EN", "EUR"])
    await expect(header.getByRole("button", { name, exact: true })).toHaveCount(0);
  for (const name of ["EN", "EUR"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  // "Step 2 of 3 · Your details" instead of the title and the step circles.
  await expect(header).toContainText("Step 2 of 3 ·Your details");
  await expect(page.getByRole("heading", { name: "Your details", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rooms", exact: true })).toBeHidden();
  // Timo's boards: the name in the hotel's colour on one line, one segment per step (two done).
  const name = header.getByText("Aether Hilltop Villas");
  await expect(name).toHaveCSS("color", await brandColour(page, "text-primary-700", "color"));
  await expect(name).toHaveCSS("white-space", "nowrap");
  const segments = page.getByTestId("checkout-progress").locator("span");
  await expect(segments).toHaveCount(3);
  const brand = await brandColour(page, "bg-primary-600", "backgroundColor");
  for (const [index, colour] of [brand, brand, "rgb(229, 231, 235)"].entries())
    await expect(segments.nth(index)).toHaveCSS("background-color", colour);
  // The step sits on white.
  await expect(page.locator("main").locator("..")).toHaveCSS("background-color", WHITE);

  // The stay in a small card; "Who's staying?" is the only heading of the form.
  const brief = page.getByTestId("stay-brief");
  await expect(brief).toContainText("Villa Five · Room only");
  await expect(brief).toContainText("1 night · 2 adults");
  expect(Math.round((await box(page, brief.locator("img"))).width)).toBe(48);
  const staying = page.getByRole("heading", { name: "Who’s staying?" });
  await expect(staying).toBeVisible();
  await expect(staying).toHaveCSS("font-size", "26px");
  // Only the optional fields are marked, as the intro says.
  await expect(
    page.getByText("Takes about 1 minute. All fields are required unless marked optional."),
  ).toBeVisible();
  await expect(page.getByText("Fields marked * are required.")).toBeHidden();
  expect(
    await page
      .locator("section span")
      .evaluateAll(
        (spans) => spans.filter((span) => span.textContent === "*" && span.offsetParent).length,
      ),
  ).toBe(0);

  // One row: the total, how the guest pays and Details beside a "Continue" button that fills the
  // rest of the row.
  const bar = await box(page, stay);
  expect(bar.height).toBeLessThanOrEqual(phone.height * 0.1);
  await expect(stay).toContainText("Pay at the hotel ·");
  const next = stay.getByRole("button", { name: "Continue to review" });
  await expect(next).toHaveText("Continue", { useInnerText: true });
  await expect(next).toBeVisible();
  const button = await box(page, next);
  expect(button.y).toBeGreaterThan(bar.y);
  expect(Math.round(button.height)).toBe(52);
  expect(Math.round(button.x + button.width)).toBe(phone.width - 16);
  expect(button.width).toBeGreaterThan(phone.width * 0.4);
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
  expect(Math.round(first.height)).toBe(52);
  // The code field is narrow: "+49", the number takes the rest.
  expect(Math.round((await box(page, page.getByLabel("Country code").locator(".."))).width)).toBe(
    96,
  );
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
  // "Price details": the room's line, taxes included, the total, the payment lines, the
  // cancellation policy in one sentence and the button. The stay is in its card above.
  await expect(stay.getByRole("heading", { name: "Price details" })).toBeVisible();
  await expect(stay.getByText("Villa Five · 1 night")).toBeVisible();
  await expect(stay.getByText("Taxes & fees", { exact: true })).toBeVisible();
  await expect(stay.getByText("Included", { exact: true })).toBeVisible();
  await expect(stay.getByText("Includes taxes & fees")).toBeHidden();
  await expect(stay.getByText("Check-in", { exact: true })).toBeHidden();
  await expect(stay.getByRole("button", { name: "Change Room 1" })).toBeHidden();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await expect(stay.getByText("At the hotel")).toBeVisible();
  await expect(
    stay.getByText("This rate can’t be cancelled or changed for a refund."),
  ).toBeVisible();
  await expect(stay.getByRole("button", { name: /^Cancellation policy/ })).toHaveCount(0);
  await expect(stay.getByRole("button", { name: "Continue to review" })).toBeInViewport();
  // Close takes the place of "Details" while it is open.
  await expect(details).toBeHidden();
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

test("ends in the slim brand footer, clear of the bar, under the bar that stays at the top", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(phone);
  await mockCheckout(page, { specialRequests: true });
  await page.goto(STAY);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");
  // The special request: a dashed box with what to ask for under it.
  const request = page.getByRole("button", { name: "Add a special request (optional)" });
  await expect(request).toHaveCSS("border-top-style", "dashed");
  await expect(request).toHaveAccessibleDescription(
    "e.g. late arrival, airport pickup, dietary needs. The hotel will reply by email.",
  );
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const footer = page.locator("footer:visible");
  await expect(footer).toHaveCount(1);
  await expect
    .poll(async () => {
      const end = await box(page, footer);
      return Math.round(end.y + end.height) <= Math.round((await box(page, stay)).y);
    })
    .toBe(true);
  // The checkout's bar is still at the top.
  expect((await box(page, page.getByRole("banner"))).y).toBe(0);
  // The name, Contact, Find my booking, Privacy choices and "Powered by vayada", all white on the
  // brand colour; no address block or copyright.
  await expect(footer.getByText("Aether Hilltop Villas", { exact: true })).toBeVisible();
  for (const name of ["Contact", "Find My Booking", "Privacy choices"])
    await expect(footer.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(footer.getByText("Powered by vayada")).toBeVisible();
  await expect(footer).not.toContainText("All rights reserved");
  await expect(footer).toHaveCSS(
    "background-color",
    await brandColour(page, "bg-primary-600", "backgroundColor"),
  );
  for (const part of await footer.locator("p:visible, button:visible").all())
    await expect(part).toHaveCSS("color", WHITE);
  await expect(stay.getByRole("button", { name: "Continue to review" })).toHaveCSS("color", WHITE);
  await page.screenshot({ path: testInfo.outputPath("details-390-end.png") });
  await footer.getByRole("button", { name: "Contact" }).click();
  await expect(footer.getByRole("link", { name: /^Email: / })).toHaveAttribute("href", /^mailto:/);
  await footer.getByRole("button", { name: "Find My Booking" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a field marked from the end of the page stops below the bar at the top", async ({ page }) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByTestId("stay-total")).toHaveText("€100");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await stay.getByRole("button", { name: "Continue to review" }).click();
  const first = page.getByLabel("First name");
  await expect(first).toBeFocused();
  const header = await box(page, page.getByRole("banner"));
  await expect.poll(async () => (await box(page, first)).y >= header.y + header.height).toBe(true);
});

test("a tap anywhere on the stay's card is Edit, back to the rooms", async ({ page }) => {
  await page.setViewportSize(phone);
  await mockCheckout(page);
  await page.goto(STAY);
  await expect(page.getByRole("button", { name: "Edit your stay" })).toBeVisible();
  // On its photo, far from the word "Edit".
  const photo = await box(page, page.getByTestId("stay-brief").locator("img"));
  await page.mouse.click(photo.x + photo.width / 2, photo.y + photo.height / 2);
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
  // The full footer.
  await expect(page.locator("footer:visible")).toContainText("All rights reserved");
  const stay = page.getByRole("complementary", { name: "Your stay" });
  await expect(stay.getByRole("heading", { name: "Your stay" })).toBeVisible();
  await expect(stay.getByText("Total", { exact: true })).toBeVisible();
  await expect(stay.getByText("Pay now")).toBeVisible();
  await expect(stay.getByRole("button", { name: "Continue to review" })).toHaveText(
    "Continue to review",
    { useInnerText: true },
  );
});
