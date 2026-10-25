import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { continueToPayment, orderTotal } from "../support/bookFlow";

const offerKey = `pricing-offer.v2:${"c".repeat(64)}`;

test("sends a pay-at-property booking request to a hotel that confirms each booking", async ({
  page,
}, testInfo) => {
  await mockBookingApis(page);
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
  let issuedQuote: any;
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    issuedQuote = {
      version: "public-booking-quote.v1",
      quoteId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "request",
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      totalMinor: "24000",
      dueNowMinor: "0",
      dueLaterMinor: "24000",
      lines: selection.rooms.map((room: any) => ({
        kind: "room",
        selectionId: room.selectionId,
        amountMinor: "24000",
      })),
      rooms: selection.rooms.map((room: any) => ({
        selectionId: room.selectionId,
        mealPlan: "room_only",
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
      })),
    };
    return route.fulfill({ json: issuedQuote });
  });
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) =>
    route.fulfill({
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
          phoneRequired: false,
          arrivalTimeEnabled: false,
          specialRequestsEnabled: false,
          checkInTime: "15:00",
          checkInUntil: "00:00",
          checkOutFrom: "06:00",
          checkOutTime: "11:00",
        },
      },
    }),
  );
  let accepted: any;
  await page.route("**/bookings/quotes/*/accept", (route) => {
    accepted = route.request().postDataJSON();
    const acceptedAt = new Date(Date.now() - 500).toISOString();
    return route.fulfill({
      json: {
        kind: "requested",
        bookingId: "55555555-5555-4555-8555-555555555555",
        bookingReference: "VAY-55555555555545558555555555555555",
        acceptanceId: "66666666-6666-4666-8666-666666666666",
        acceptedAt,
        hostResponseDeadlineAt: new Date(Date.parse(acceptedAt) + 24 * 3600_000).toISOString(),
        checkedAt: new Date().toISOString(),
      },
    });
  });

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await continueToPayment(page, { method: "pay_at_property" });
  await expect(orderTotal(page)).toHaveText("€240");
  // VAY-2195: the payment step says what happens next for a hotel that confirms each booking.
  await expect(page.getByText(/If the hotel accepts your request/)).toBeVisible();
  await page.getByLabel("I have read the room and rate terms for this price").check();
  await page.getByLabel("guest rules for this price").check();
  const send = page.getByRole("button", { name: "Send booking request" });
  await expect(send).toBeEnabled();
  await send.click();

  // VAY-2195: a sent request opens its confirmation page, as on the old booking pages.
  await expect(page).toHaveURL(/\/booking\/VAY-55555555555545558555555555555555$/);
  await expect(page.getByRole("heading", { name: /^Request sent/ })).toBeVisible();
  // VAY-2307: the long reference reads in groups of four.
  await expect(page.getByText("VAY-5555 5555 5555 4555 8555 5555 5555 5555")).toBeVisible();
  await expect(page.getByText(/You're all set/)).toHaveCount(0);
  // Without the server's answer, the page still shows what is owed at the hotel.
  await expect(page.getByText("Due at the hotel", { exact: true }).locator("..")).toContainText(
    "€240",
  );
  expect(accepted).toMatchObject({
    version: "booking-quote-acceptance.v1",
    quoteId: issuedQuote.quoteId,
    guest: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  });
  await page.screenshot({ path: testInfo.outputPath("request-sent-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("request-sent-mobile.png"), fullPage: true });
});
