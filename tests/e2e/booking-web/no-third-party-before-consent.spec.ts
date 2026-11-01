import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice, paymentOption } from "../support/bookFlow";

// VAY-2216: until the guest has answered the privacy choice, the booking pages only talk to us.
// The hotel's Design Studio fonts come from our own origin, and Stripe.js loads only once the
// card form shows.
const offerKey = `pricing-offer.v2:${"e".repeat(64)}`;

/** Every http(s) request that leaves the booking page's own origin, as origin + path. */
function otherOrigins(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL!).origin;
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== origin)
      requests.push(`${url.origin}${url.pathname}`);
  });
  return requests;
}

/** Loaded font faces of the family the hotel's heading font variable names first. */
function loadedHeadingFaces(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const heading = getComputedStyle(document.documentElement).getPropertyValue("--font-heading");
    const family = heading.split(",")[0]!.trim().replace(/['"]/g, "");
    return [...document.fonts].filter(
      (face) => face.family.replace(/['"]/g, "") === family && face.status === "loaded",
    ).length;
  });
}

// Every Design Studio pairing (packages/domain-booking BOOKING_DESIGN_FONT_PAIRINGS).
for (const fontPairing of [
  "high-end-serif",
  "modern-minimalist",
  "grand-classic",
  "imperial-serif",
  "italiana-serif",
]) {
  test(`serves the ${fontPairing} fonts from the booking site itself`, async ({
    page,
    baseURL,
  }) => {
    await mockBookingApis(page, { fontPairing });
    await mockAnyPrice(page);
    const outside = otherOrigins(page, baseURL);
    const fontFiles: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "font") fontFiles.push(request.url());
    });
    await page.goto("/?checkIn=2026-09-12&checkOut=2026-09-15");
    await expect(
      page.getByRole("heading", { name: "Optional analytics", exact: true }),
    ).toBeVisible();
    await expect.poll(() => loadedHeadingFaces(page)).toBeGreaterThan(0);
    expect(fontFiles.length).toBeGreaterThan(0);
    for (const file of fontFiles) expect(new URL(file).origin).toBe(new URL(baseURL!).origin);

    // /book with the default catalogue room card's choice (VAY-2446: /book needs one): still
    // nothing from Google or Stripe.
    await page.goto(
      `/book?checkIn=2026-09-12&checkOut=2026-09-15&adults=2&offer=pricing-offer.v2:${"a".repeat(64)}`,
    );
    await expect(page).toHaveURL(/[?&]step=(extras|details)/);
    // Nothing to wait for when all is well: give a late script tag a moment to show up.
    await page.waitForTimeout(1500);
    expect(outside).toEqual([]);
    expect(
      await page.evaluate(
        (slug) => localStorage.getItem(`vayada_booking_analytics:${slug}`),
        SEEDED_BOOKING_SLUG,
      ),
    ).toBeNull();
  });
}

test("loads Stripe.js only once the card form shows", async ({ page, baseURL }) => {
  await mockBookingApis(page, { fontPairing: "grand-classic" });
  await mockAnyPrice(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: true,
        bookingPagePaymentMethods: ["pay_at_property", "card"],
      },
    }),
  );
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "double",
            name: "Double",
            offers: [{ publicOfferKey: offerKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({ json: { version: "public-pricing-addons.v1", addons: [] } }),
  );
  await page.route("**/bookings/quotes/*/accept", (route) =>
    route.fulfill({
      json: {
        kind: "payment_required",
        bookingId: "88888888-8888-4888-8888-888888888888",
        bookingReference: "VAY-CARDFORM2216",
        payment: {
          provider: "stripe",
          clientSecret: "pi_vay2216_secret_test",
          stripeAccountId: "acct_vay2216",
          paymentIntentId: "pi_vay2216",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      },
    }),
  );
  // An empty script: this spec only checks when Stripe.js is asked for, never Stripe itself.
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  const outside = otherOrigins(page, baseURL);

  await page.goto(`/en/book?checkIn=2026-12-01&checkOut=2026-12-03&adults=2&offer=${offerKey}`);
  await expect(page).toHaveURL(/[?&]step=details/);
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(page).toHaveURL(/[?&]step=payment/);
  await paymentOption(page, "card").click();
  await expect(paymentOption(page, "card")).toHaveAttribute("aria-checked", "true");
  await page.getByLabel(/I agree to the cancellation policy/).check();
  expect(outside).toEqual([]);

  await page.getByRole("button", { name: "Continue to card details" }).click();
  await expect.poll(() => outside).toContain("https://js.stripe.com/v3");
  expect(outside.every((url) => url.startsWith("https://js.stripe.com/"))).toBe(true);
});
