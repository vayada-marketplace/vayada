import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { continueToPayment, orderTotal } from "../support/bookFlow";

// VAY-2205: a rate paid with a deposit takes part of the stay by card when booking and leaves the
// rest to pay at the hotel; the payment step says both amounts before the guest books.
const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;
const deposit = {
  kind: "deposit",
  basisPoints: 3000,
  balanceDaysBeforeArrival: 0,
  acceptedMethods: ["card"],
};

test("says what the card pays now and what is left to pay at the hotel", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: false,
        bookingPagePaymentMethods: ["card"],
        termsText: null,
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
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    return route.fulfill({
      json: {
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
        dueNowMinor: "7200",
        dueLaterMinor: "16800",
        lines: selection.rooms.map((room: { selectionId: string }) => ({
          kind: "room",
          selectionId: room.selectionId,
          amountMinor: "24000",
        })),
        rooms: selection.rooms.map((room: { selectionId: string }) => ({
          selectionId: room.selectionId,
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          payment: deposit,
        })),
      },
    });
  });

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await continueToPayment(page, { method: "card" });
  await expect(orderTotal(page)).toHaveText("€240");
  await expect(
    page.getByText(
      "We charge €72 to your card when you confirm, and you pay the rest, €168, at the hotel. You enter your card details in the next step.",
    ),
  ).toBeVisible();
  const summary = page.getByRole("complementary", { name: "Your stay" });
  await expect(summary.getByText("Charged now")).toBeVisible();
  await expect(summary.getByText("At the hotel")).toBeVisible();
  await page.getByRole("button", { name: "Read the room and rate terms" }).click();
  await expect(
    page.getByText("Payment terms: 30% when booking, the rest at the property."),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("card-deposit-payment.png"), fullPage: true });
  await assertHealthy();
});
