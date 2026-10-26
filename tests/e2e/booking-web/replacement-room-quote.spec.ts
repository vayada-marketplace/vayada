import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import {
  continueToPayment,
  fillGuestDetails,
  orderTotal,
  paymentOption,
} from "../support/bookFlow";

const firstKey = `pricing-offer.v2:${"a".repeat(64)}`;
const breakfastId = "22222222-2222-4222-8222-222222222222";
const secondKey = `pricing-offer.v2:${"b".repeat(64)}`;
test("prices explicit mixed rooms and child ages, clears edits, and recovers from expired quotes", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page, {
    supportedQuoteParameters: { adultAgeThreshold: 16, childrenSupported: false },
  });
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "suite",
            name: "Suite",
            offers: [{ publicOfferKey: firstKey, currency: "EUR", mealPlan: "breakfast" }],
          },
          {
            roomTypeId: "twin",
            name: "Twin",
            offers: [{ publicOfferKey: secondKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-addons.v1",
        addons: [
          {
            id: breakfastId,
            name: "Extra breakfast",
            currency: "EUR",
            pricingModel: "per_guest_night",
            maxQuantity: 1,
            maxGuests: 4,
          },
        ],
      },
    }),
  );
  let issuedQuote: any;
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) => {
    expect(route.request().url()).toContain(`/quotes/${issuedQuote.quoteId}/guest-disclosure`);
    return route.fulfill({
      json: {
        version: "public-quote-guest-disclosure.v1",
        quoteId: issuedQuote.quoteId,
        quoteEvidenceId: `sha256:${"a".repeat(64)}`,
        guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
        issuedAt: issuedQuote.issuedAt,
        expiresAt: issuedQuote.expiresAt,
        checkedAt: new Date().toISOString(),
        propertyTimeZone: "Europe/Berlin",
        choices: {
          defaultGuestLanguage: "en",
          childrenEnabled: true,
          adultAgeThreshold: 12,
          phoneRequired: true,
          arrivalTimeEnabled: true,
          specialRequestsEnabled: true,
          checkInTime: "15:00",
          checkInUntil: "00:00",
          checkOutFrom: "06:00",
          checkOutTime: "11:00",
        },
      },
    });
  });
  let submitted: any;
  let requests = 0;
  // Generous by default; the test shortens it to watch a price expire.
  let lifetimeMs = 60_000;
  await page.route("**/bookings/quote", (route) => {
    submitted = route.request().postDataJSON();
    requests++;
    const { selection, paymentMethod } = submitted;
    const withExtra = selection.addons.length > 0;
    issuedQuote = {
      version: "public-booking-quote.v1",
      quoteId: `11111111-1111-4111-8111-${String(requests).padStart(12, "0")}`,
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "instant",
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
      totalMinor: withExtra ? "32000" : "31500",
      dueNowMinor: "0",
      dueLaterMinor: withExtra ? "32000" : "31500",
      lines: [
        ...selection.rooms.map((room: any, index: number) => ({
          kind: "room",
          selectionId: room.selectionId,
          amountMinor: index === 0 ? "20000" : "11500",
        })),
        ...(withExtra ? [{ kind: "addon", selectionId: null, amountMinor: "500" }] : []),
      ],
      rooms: selection.rooms.map((room: any) => ({
        selectionId: room.selectionId,
        mealPlan: room.publicOfferKey === firstKey ? "breakfast" : "room_only",
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
      })),
    };
    return route.fulfill({ json: issuedQuote });
  });
  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await expect(page.getByRole("heading", { name: "Choose rooms and get a price" })).toBeVisible();
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const first = page.getByRole("group", { name: "Room 1", exact: true });
  const second = page.getByRole("group", { name: "Room 2", exact: true });
  await first.getByLabel("Room and meal option").selectOption(firstKey);
  await first.getByLabel(/Adults/).fill("2");
  await first.getByRole("button", { name: "Add child to room 1" }).click();
  await second.getByLabel("Room and meal option").selectOption(secondKey);
  await second.getByLabel(/Adults/).fill("1");
  await page.getByLabel("Promo code (optional)").fill("SAVE10");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeDisabled();
  expect(requests).toBe(0);
  await expect(
    first.getByLabel("Child 1: age at check-in").getByRole("option", { name: "17", exact: true }),
  ).toHaveCount(1);
  await first.getByLabel("Child 1: age at check-in").selectOption("0");
  await next.click();
  // VAY-2195: the extras are their own step, priced as they change.
  await expect(page).toHaveURL(/[?&]step=extras/);
  const total = page.getByRole("status", { name: "Your stay total" });
  await expect(total).toContainText("€315");
  const extras = page.getByRole("region", { name: "Optional extras" });
  const toPayment = page.getByRole("button", { name: "Continue to your details" });
  // Added for every guest it can take and every night, like the old page.
  await extras.getByRole("button", { name: "Add Extra breakfast" }).click();
  const night = (day: string) => extras.getByRole("button", { name: `Extra breakfast on ${day}` });
  await expect(extras.getByText("4/4", { exact: true })).toBeVisible();
  await expect(night("Thu 1 Oct")).toHaveAttribute("aria-pressed", "true");
  await expect(night("Fri 2 Oct")).toHaveAttribute("aria-pressed", "true");
  await expect(night("Sat 3 Oct")).toHaveCount(0);
  await night("Thu 1 Oct").click();
  await expect(night("Thu 1 Oct")).toHaveAttribute("aria-pressed", "false");
  // The last night stays: a nightly extra needs one.
  await night("Fri 2 Oct").click();
  await expect(night("Fri 2 Oct")).toHaveAttribute("aria-pressed", "true");
  for (let i = 0; i < 3; i++)
    await extras.getByRole("button", { name: "Fewer for Extra breakfast" }).click();
  await expect(extras.getByText("1/4", { exact: true })).toBeVisible();
  await expect(extras.getByRole("button", { name: "Fewer for Extra breakfast" })).toBeDisabled();
  await expect(toPayment).toBeEnabled();
  await expect(total).toContainText("€320");
  await expect(extras.getByText("Your extras (1)")).toBeVisible();
  await toPayment.click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(paymentOption(page, "pay_at_property")).toHaveAttribute("aria-checked", "true");
  await expect(orderTotal(page)).toHaveText("€320");
  // VAY-2347: "Before you book" shows the policy, the rules behind their row, and one tick.
  const acknowledgement = page.getByLabel(/^I agree to the cancellation policy/);
  await expect(page.getByRole("table", { name: /[Cc]ancellation/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Guest rules" }).click();
  await expect(page.getByRole("region", { name: "Guest rules", exact: true })).toContainText(
    "midnight at the end of your arrival day",
  );
  await expect(page.getByRole("region", { name: "Guest rules", exact: true })).toContainText(
    "Guests from 12 count as adults.",
  );
  await acknowledgement.check();
  await expect(acknowledgement).toBeChecked();
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  expect(submitted.selection.rooms.map((room: any) => [room.publicOfferKey, room.guests])).toEqual([
    [firstKey, { adults: 2, childAgesAtCheckIn: [0] }],
    [secondKey, { adults: 1, childAgesAtCheckIn: [] }],
  ]);
  expect(submitted.selection.promoCode).toBe("SAVE10");
  expect(submitted.selection.version).toBe("public-pricing-selection.v2");
  expect(submitted.selection.addons).toEqual([
    {
      version: "addon-selection.v2",
      id: breakfastId,
      quantity: 1,
      people: [{ selectionId: submitted.selection.rooms[0].selectionId, kind: "adult", index: 0 }],
      dates: ["2026-10-02"],
    },
  ]);
  expect(new Set(submitted.selection.rooms.map((room: any) => room.selectionId)).size).toBe(2);
  // Back to the rooms: a changed child retires the extras and the price, and its terms.
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]step=/);
  lifetimeMs = 2500;
  await first.getByLabel("Child 1: age at check-in").selectOption("7");
  await next.click();
  await expect(extras.getByRole("button", { name: "Add Extra breakfast" })).toBeVisible();
  await toPayment.click();
  // The details step keeps what the guest typed.
  await expect(page.getByLabel("First name")).toHaveValue("Ada");
  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(orderTotal(page)).toHaveText("€315");
  await expect(acknowledgement).not.toBeChecked();
  expect(submitted.selection.addons).toEqual([]);
  await expect(page.getByText(/This price has expired/)).toBeVisible({ timeout: 6000 });
  await expect(orderTotal(page)).toBeVisible();
  await expect(acknowledgement).toBeDisabled();
  lifetimeMs = 60_000;
  await page.getByRole("button", { name: "Get an updated price" }).click();
  await expect(orderTotal(page)).toHaveText("€315");
  await expect(acknowledgement).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("room-quote-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("room-quote-mobile.png"), fullPage: true });
});

test("retries unavailable catalogue without inventing a room option", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page);
  // Analytics choice already made, so the privacy panel doesn't cover the retry button.
  await page.addInitScript(
    ({ slug, version }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      ),
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: { version: "public-pricing-addons.v1", addons: [] },
    }),
  );
  let unavailable = true;
  await page.route("**/pricing-offers", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { version: "public-pricing-offers.v1", rooms: [] } }),
  );
  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}`);
  await expect(page.getByRole("button", { name: "Retry room options" })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Retry room options" }).click();
  await expect(page.getByText("Room options are currently unavailable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
});

test("keeps the charged currency first when the guest views prices in another currency", async ({
  page,
}) => {
  await mockBookingApis(page, {
    headerSettings: {
      showContactButton: true,
      showReferAGuestButton: false,
      showLanguageSelector: true,
      showCurrencySelector: true,
    },
  });
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "suite",
            name: "Suite",
            offers: [{ publicOfferKey: firstKey, currency: "EUR", mealPlan: "breakfast" }],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({ json: { version: "public-pricing-addons.v1", addons: [] } }),
  );
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        version: "public-booking-quote.v1",
        quoteId: "11111111-1111-4111-8111-000000000009",
        replayed: false,
        checkIn: selection.checkIn,
        checkOut: selection.checkOut,
        currency: "EUR",
        paymentMethod,
        acceptanceMode: "instant",
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        totalMinor: "31500",
        dueNowMinor: "0",
        dueLaterMinor: "31500",
        lines: [
          { kind: "room", selectionId: selection.rooms[0].selectionId, amountMinor: "31500" },
        ],
        rooms: selection.rooms.map((room: any) => ({
          selectionId: room.selectionId,
          mealPlan: "breakfast",
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
        })),
      },
    });
  });

  await page.goto("/en");
  const nav = page.locator("nav");
  await nav.getByRole("button", { name: "EUR", exact: true }).click();
  await nav.getByRole("button", { name: "$ US Dollar" }).click();
  await expect(nav.getByRole("button", { name: "USD", exact: true })).toBeVisible();

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(firstKey);
  await room.getByLabel(/Adults/).fill("2");
  await continueToPayment(page, { method: "pay_at_property" });

  await expect(orderTotal(page)).toHaveText("€315 (≈ US$347)");
  await expect(page.getByRole("complementary", { name: "Your stay" })).toContainText(
    /At the hotel\s*€315 \(≈ US\$347\)/,
  );
  await expect(page.getByTestId("approximate-amounts-note")).toContainText(
    "We charge in EUR. Amounts marked ≈ are approximate conversions.",
  );
  await expect(page.getByRole("link", { name: "Rates By Exchange Rate API" })).toHaveAttribute(
    "href",
    "https://www.exchangerate-api.com",
  );
});
