import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;

test.use({ viewport: { width: 1440, height: 900 } });

// VAY-2163: the /book guest form must not change under the guest, and must not invite a booking
// the hotel can't take.
test("keeps Confirm booking off after the general online-booking error", async ({
  page,
}, testInfo) => {
  await openQuote(page);
  await page.route("**/bookings/quotes/*/accept", (route) =>
    route.fulfill({ status: 404, json: { statusCode: 404, message: "Not Found" } }),
  );
  await acknowledge(page);
  await fillGuest(page);
  const confirm = page.getByRole("button", { name: "Confirm booking" });
  await confirm.click();
  await expect(
    page.getByText("Online booking is not available for this hotel right now."),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("book-online-unavailable-1440.png") });
  await expect(confirm).toBeDisabled();
});

test("keeps the hotel's guest rules in the form when the price expires", async ({
  page,
}, testInfo) => {
  await openQuote(page, { lifetimeMs: 8000 });
  await acknowledge(page);
  await fillGuest(page);
  await page.getByLabel("Expected arrival time (optional)").fill("17:30");
  await page.getByLabel("Special requests (optional)").fill("Quiet room, please.");
  await page.screenshot({
    path: testInfo.outputPath("book-price-current-1440.png"),
    fullPage: true,
  });
  await expect(page.getByText(/This price has expired/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: testInfo.outputPath("book-price-expired-1440.png"),
    fullPage: true,
  });
  await expect(page.getByText("Phone (optional)")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Phone", exact: true })).toHaveAttribute(
    "required",
    "",
  );
  await expect(page.getByLabel("Expected arrival time (optional)")).toHaveValue("17:30");
  await expect(page.getByLabel("Special requests (optional)")).toHaveValue("Quiet room, please.");
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
});

test("requires the phone while the guest rules can't be loaded", async ({ page }, testInfo) => {
  await openQuote(page, { rulesStatus: 503 });
  await expect(page.getByText(/couldn.t verify our guest rules/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("book-guest-rules-failed-1440.png"),
    fullPage: true,
  });
  await expect(page.getByText("Phone (optional)")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Phone", exact: true })).toHaveAttribute(
    "required",
    "",
  );
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeDisabled();
});

async function openQuote(page: Page, { lifetimeMs = 300_000, rulesStatus = 200 } = {}) {
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
  let quote: { quoteId: string; issuedAt: string; expiresAt: string } | null = null;
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    const issuedAt = Date.now() - 1000;
    quote = {
      version: "public-booking-quote.v1",
      quoteId: "77777777-7777-4777-8777-777777777777",
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "instant",
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 1000 + lifetimeMs).toISOString(),
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
    } as typeof quote;
    return route.fulfill({ json: quote });
  });
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) =>
    rulesStatus !== 200
      ? route.fulfill({ status: rulesStatus, json: {} })
      : route.fulfill({
          json: {
            version: "public-quote-guest-disclosure.v1",
            quoteId: quote!.quoteId,
            quoteEvidenceId: `sha256:${"a".repeat(64)}`,
            guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
            issuedAt: quote!.issuedAt,
            expiresAt: quote!.expiresAt,
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
              checkOutTime: "11:00",
            },
          },
        }),
  );

  await page.goto(`/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=2026-12-01&checkOut=2026-12-03`);
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await page.getByLabel("Payment preference").selectOption("pay_at_property");
  await page.getByRole("button", { name: "Get price", exact: true }).click();
  await expect(page.getByText("Total: EUR 240.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
}

async function acknowledge(page: Page) {
  await page.getByLabel("I have read the room and rate terms for this price preview.").check();
  await page.getByLabel("I have read the guest rules for this price preview.").check();
}

async function fillGuest(page: Page) {
  await page.getByLabel("First name").fill("Ada");
  await page.getByLabel("Last name").fill("Lovelace");
  await page.getByLabel("Email", { exact: true }).fill("ada@example.test");
  await page.getByRole("textbox", { name: "Phone", exact: true }).fill("+49 30 1234567");
}
