import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

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
      expiresAt: new Date(Date.now() + (requests === 1 ? 8000 : 2500)).toISOString(),
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
  await page.getByLabel("Payment preference").selectOption("pay_at_property");
  await page.getByLabel("Promo code (optional)").fill("SAVE10");
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toBeDisabled();
  expect(requests).toBe(0);
  await expect(
    first.getByLabel("Child 1: age at check-in").getByRole("option", { name: "17", exact: true }),
  ).toHaveCount(1);
  await first.getByLabel("Child 1: age at check-in").selectOption("0");
  const extras = page.getByRole("region", { name: "Optional extras" });
  await extras.getByLabel("Add Extra breakfast", { exact: true }).check();
  const getPrice = page.getByRole("button", { name: "Get price", exact: true });
  await expect(getPrice).toBeDisabled();
  await expect(extras.getByLabel("2026-10-03", { exact: true })).toHaveCount(0);
  await extras.getByLabel("Room 1, child 1 (age 0 at check-in)", { exact: true }).check();
  await expect(getPrice).toBeDisabled();
  await extras.getByLabel("2026-10-02", { exact: true }).check();
  await expect(getPrice).toBeEnabled();
  await extras.getByLabel("2026-10-02", { exact: true }).uncheck();
  await expect(getPrice).toBeDisabled();
  expect(requests).toBe(0);
  await extras.getByLabel("2026-10-02", { exact: true }).check();
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 320.00", { exact: true })).toBeVisible();
  const acknowledgement = page.getByLabel(
    "I have read the room and rate terms for this price preview.",
  );
  await expect(
    page
      .getByRole("region", { name: "Room 1 terms" })
      .getByText("Meals: Breakfast", { exact: true }),
  ).toBeVisible();
  await acknowledgement.check();
  await expect(acknowledgement).toBeChecked();
  const guestAcknowledgement = page.getByLabel(
    "I have read the guest rules for this price preview.",
  );
  await expect(page.getByRole("region", { name: "Guest rules", exact: true })).toContainText(
    "midnight at the end of your arrival day",
  );
  await expect(page.getByRole("region", { name: "Guest rules", exact: true })).toContainText(
    "Our adult age threshold is 12",
  );
  await guestAcknowledgement.check();
  await expect(guestAcknowledgement).toBeChecked();
  if (process.env.E2E_REPLACEMENT_PRICING_ACCEPTANCE_EXPECTED === "true") {
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  }
  await expect(page.getByRole("heading", { name: "Your room and rate terms" })).toBeVisible();
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
      people: [{ selectionId: submitted.selection.rooms[0].selectionId, kind: "child", index: 0 }],
      dates: ["2026-10-02"],
    },
  ]);
  expect(new Set(submitted.selection.rooms.map((room: any) => room.selectionId)).size).toBe(2);
  await first.getByLabel("Child 1: age at check-in").selectOption("7");
  await expect(page.getByRole("region", { name: "Your stay price" })).toHaveCount(0);
  await expect(guestAcknowledgement).toHaveCount(0);
  await expect(extras.getByLabel("Add Extra breakfast", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 315.00", { exact: true })).toBeVisible();
  await expect(acknowledgement).not.toBeChecked();
  await expect(guestAcknowledgement).not.toBeChecked();
  expect(submitted.selection.addons).toEqual([]);
  await expect(page.getByText(/This price has expired/)).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole("region", { name: "Your stay price" })).toBeVisible();
  await expect(acknowledgement).toBeDisabled();
  await expect(guestAcknowledgement).toBeDisabled();
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 315.00", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("room-quote-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("room-quote-mobile.png"), fullPage: true });
});

test("retries unavailable catalogue without inventing a room option", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page);
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
  await expect(page.getByRole("button", { name: "Get price", exact: true })).toHaveCount(0);
});
