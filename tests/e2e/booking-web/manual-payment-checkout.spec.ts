import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { continueToPayment, mockAnyPrice, orderTotal, paymentOption } from "../support/bookFlow";

const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;

// VAY-2139: a bank-transfer-only hotel. The guest books, the room is held, and the guest is
// sent to the protected payment details.
test("books by bank transfer and opens the protected payment details", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: false,
        bookingPagePaymentMethods: ["bank_transfer"],
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
  let issuedQuote: any;
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    issuedQuote = {
      version: "public-booking-quote.v1",
      quoteId: "77777777-7777-4777-8777-777777777777",
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "instant",
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      totalMinor: "24000",
      dueNowMinor: "24000",
      dueLaterMinor: "0",
      lines: selection.rooms.map((room: any) => ({
        kind: "room",
        selectionId: room.selectionId,
        amountMinor: "24000",
      })),
      rooms: selection.rooms.map((room: any) => ({
        selectionId: room.selectionId,
        mealPlan: "room_only",
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["bank_transfer"] },
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
  const token = "t".repeat(43);
  const reference = "VAY-77777777777747778777777777777777";
  await page.route("**/bookings/quotes/*/accept", (route) => {
    const acceptedAt = new Date(Date.now() - 500).toISOString();
    return route.fulfill({
      json: {
        kind: "payment_pending",
        bookingId: "88888888-8888-4888-8888-888888888888",
        acceptanceId: "99999999-9999-4999-8999-999999999999",
        acceptedAt,
        bookingReference: reference,
        payment: {
          method: "bank_transfer",
          amountMinor: "24000",
          currency: "EUR",
          deadlineAt: new Date(Date.parse(acceptedAt) + 48 * 3600_000).toISOString(),
        },
        checkedAt: new Date().toISOString(),
        confirmationToken: token,
        confirmationTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
  });
  let confirmations = 0;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      confirmations++;
      expect(route.request().postDataJSON()).toEqual({
        bookingReference: reference,
        confirmationToken: token,
      });
      await route.fulfill({
        json: {
          id: "88888888-8888-4888-8888-888888888888",
          bookingReference: reference,
          status: "pending_payment",
          paymentStatus: "unpaid",
          paymentMethod: "bank_transfer",
          hotelName: "Hotel Alpenrose",
          roomName: "Double",
          guestFirstName: "Ada",
          guestLastName: "Lovelace",
          guestEmail: "ada@example.test",
          checkIn: "2026-10-01",
          checkOut: "2026-10-03",
          nights: 2,
          adults: 2,
          children: 0,
          numberOfRooms: 1,
          currency: "EUR",
          totalAmount: 240,
          createdAt: new Date().toISOString(),
          bankTransferDetails: "IBAN: DE89370400440532013000",
        },
      });
    },
  );

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await continueToPayment(page);
  const methods = page.getByRole("radiogroup", { name: "Payment preference" }).getByRole("radio");
  await expect(methods).toHaveCount(1);
  await expect(paymentOption(page, "bank_transfer")).toHaveAttribute("aria-checked", "true");
  await expect(orderTotal(page)).toHaveText("€240");
  await expect(
    page.getByText(/We hold your room until the payment deadline, and your booking is confirmed/),
  ).toBeVisible();
  await page.getByLabel("I have read the room and rate terms for this price").check();
  await page.getByLabel("guest rules for this price").check();
  await page.getByRole("button", { name: "Confirm booking" }).click();

  // VAY-2195: the reservation opens its protected confirmation page, as a booking does.
  await expect(page).toHaveURL(new RegExp(`/confirmation\\?booking=${reference}&token=${token}$`));
  expect(
    await page.evaluate((slug) => sessionStorage.getItem(`bookFlow:${slug}`), SEEDED_BOOKING_SLUG),
  ).toBeNull();
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toBeVisible();
  expect(confirmations).toBeGreaterThan(0);
});

// VAY-2145: bank transfer only when its 48-hour deadline ends before check-in.
test("hides bank transfer for arrivals closer than its payment deadline", async ({ page }) => {
  await mockBookingApis(page);
  // The steps continue with a price (VAY-2195).
  await mockAnyPrice(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: true,
        bookingPagePaymentMethods: ["pay_at_property", "bank_transfer"],
        manualPaymentEarliestArrival: { bank_transfer: "2026-10-05" },
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

  const methods = page.getByRole("radiogroup", { name: "Payment preference" }).getByRole("radio");
  for (const checkIn of ["2026-10-01", "2026-10-06"]) {
    const checkOut = checkIn === "2026-10-01" ? "2026-10-03" : "2026-10-08";
    await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=${checkIn}&checkOut=${checkOut}`);
    await page.getByRole("button", { name: "Add room", exact: true }).click();
    const room = page.getByRole("group", { name: "Room 1", exact: true });
    await room.getByLabel("Room and meal option").selectOption(offerKey);
    await room.getByLabel(/Adults/).fill("2");
    await continueToPayment(page);
    if (checkIn === "2026-10-01") {
      await expect(methods).toHaveCount(1);
      await expect(paymentOption(page, "pay_at_property")).toBeVisible();
      await expect(
        page.getByText("Pay by bank transfer isn’t available this close to check-in."),
      ).toBeVisible();
    }
  }
  await expect(methods).toHaveCount(2);
  await expect(paymentOption(page, "bank_transfer")).toBeVisible();
  await expect(
    page.getByText("Pay by bank transfer isn’t available this close to check-in."),
  ).toHaveCount(0);
});
