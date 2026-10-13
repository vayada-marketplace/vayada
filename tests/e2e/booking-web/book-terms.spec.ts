import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const offerKey = `pricing-offer.v2:${"c".repeat(64)}`;
const terms = "These are our house terms.\n\n1. Your booking\nWe confirm by email.";

// VAY-2176: /book shows the hotel's own Terms & Conditions under its guest rules.
test("shows the hotel's terms under the guest rules and says booking accepts them", async ({
  page,
}) => {
  await openQuote(page, terms);
  const section = page.getByRole("region", { name: "Our terms & conditions" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("These are our house terms.");
  await expect(section).toContainText("We confirm by email.");
  await expect(page.getByText("By booking, you agree to our terms & conditions.")).toBeVisible();
});

test("shows no terms section or agreement line when the hotel has no terms", async ({ page }) => {
  await openQuote(page, "  ");
  await expect(page.getByRole("heading", { name: "Our terms & conditions" })).toHaveCount(0);
  await expect(page.getByText("By booking, you agree to our terms & conditions.")).toHaveCount(0);
});

async function openQuote(page: Page, termsText: string) {
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        showAddonsStep: true,
        payAtPropertyEnabled: true,
        onlineCardPayment: false,
        freeCancellationDays: 7,
        phoneRequired: true,
        termsText,
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
  let issuedQuote: { quoteId: string; issuedAt: string; expiresAt: string } | null = null;
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    const quote = {
      version: "public-booking-quote.v1",
      quoteId: "44444444-4444-4444-8444-444444444444",
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "instant",
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      totalMinor: "24000",
      dueNowMinor: "0",
      dueLaterMinor: "24000",
      lines: selection.rooms.map((room: { selectionId: string }) => ({
        kind: "room",
        selectionId: room.selectionId,
        amountMinor: "24000",
      })),
      rooms: selection.rooms.map((room: { selectionId: string }) => ({
        selectionId: room.selectionId,
        mealPlan: "room_only",
        cancellation: { kind: "non_refundable" },
        payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
      })),
    };
    issuedQuote = quote;
    return route.fulfill({ json: quote });
  });
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) =>
    route.fulfill({
      json: {
        version: "public-quote-guest-disclosure.v1",
        quoteId: issuedQuote!.quoteId,
        quoteEvidenceId: `sha256:${"a".repeat(64)}`,
        guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
        issuedAt: issuedQuote!.issuedAt,
        expiresAt: issuedQuote!.expiresAt,
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
          checkOutTime: "11:00",
        },
      },
    }),
  );

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await page.getByLabel("Payment preference").selectOption("pay_at_property");
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 240.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Our guest rules" })).toBeVisible();
}
