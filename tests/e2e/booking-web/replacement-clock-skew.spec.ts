import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { continueToPayment, orderTotal } from "../support/bookFlow";

const offerKey = `pricing-offer.v2:${"a".repeat(64)}`;

// The mocked API stamps real time, like the server; only the guest's device clock is off.
// A device clock behind the server made the quote look issued in the future and the guest
// rules unverifiable; one ahead made a fresh quote look expired (VAY-2134).
for (const [label, skewMs] of [
  ["2 minutes behind", -120_000],
  ["2 minutes ahead", 120_000],
  ["6 minutes ahead", 360_000],
] as const) {
  test(`books when the device clock is ${label} the server`, async ({ page }) => {
    await page.clock.setSystemTime(new Date(Date.now() + skewMs));
    await mockBookingApis(page);
    await page.route("**/pricing-offers", (route) =>
      route.fulfill({
        json: {
          version: "public-pricing-offers.v1",
          rooms: [
            {
              roomTypeId: "suite",
              name: "Suite",
              offers: [{ publicOfferKey: offerKey, currency: "EUR", mealPlan: "room_only" }],
            },
          ],
        },
      }),
    );
    await page.route("**/pricing-addons", (route) =>
      route.fulfill({ json: { version: "public-pricing-addons.v1", addons: [] } }),
    );
    let quote: any;
    await page.route("**/bookings/quote", (route) => {
      const { selection, paymentMethod } = route.request().postDataJSON();
      const issuedAt = Date.now();
      quote = {
        version: "public-booking-quote.v1",
        quoteId: "11111111-1111-4111-8111-000000000001",
        replayed: false,
        checkIn: selection.checkIn,
        checkOut: selection.checkOut,
        currency: "EUR",
        paymentMethod,
        acceptanceMode: "instant",
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + 300_000).toISOString(),
        totalMinor: "18000",
        dueNowMinor: "0",
        dueLaterMinor: "18000",
        lines: [
          { kind: "room", selectionId: selection.rooms[0].selectionId, amountMinor: "18000" },
        ],
        rooms: selection.rooms.map((room: any) => ({
          selectionId: room.selectionId,
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
        })),
      };
      return route.fulfill({ json: quote });
    });
    await page.route("**/bookings/quotes/*/guest-disclosure", (route) =>
      route.fulfill({
        json: {
          version: "public-quote-guest-disclosure.v1",
          quoteId: quote.quoteId,
          quoteEvidenceId: `sha256:${"a".repeat(64)}`,
          guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
          issuedAt: quote.issuedAt,
          expiresAt: quote.expiresAt,
          checkedAt: new Date().toISOString(),
          propertyTimeZone: "Europe/Berlin",
          choices: {
            defaultGuestLanguage: "en",
            childrenEnabled: true,
            adultAgeThreshold: 12,
            phoneRequired: true,
            arrivalTimeEnabled: false,
            specialRequestsEnabled: true,
            checkInTime: "15:00",
            checkInUntil: "00:00",
            checkOutFrom: "06:00",
            checkOutTime: "11:00",
          },
        },
      }),
    );

    await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-10-01&checkOut=2026-10-03`);
    await expect(page.getByRole("heading", { name: "Choose rooms and get a price" })).toBeVisible();
    await page.getByRole("button", { name: "Add room", exact: true }).click();
    const room = page.getByRole("group", { name: "Room 1", exact: true });
    await room.getByLabel("Room and meal option").selectOption(offerKey);
    await room.getByLabel(/Adults/).fill("2");
    await continueToPayment(page, { method: "pay_at_property" });
    await expect(orderTotal(page)).toHaveText("€180");

    const terms = page.getByLabel("I have read the room and rate terms for this price");
    await expect(terms).toBeEnabled();
    await terms.check();
    await expect(page.getByText(/couldn.t verify our guest rules/)).toHaveCount(0);
    const rules = page.getByLabel("guest rules for this price");
    await rules.check();
    await expect(rules).toBeChecked();
    await expect(page.getByText("Phone (optional)")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
  });
}
