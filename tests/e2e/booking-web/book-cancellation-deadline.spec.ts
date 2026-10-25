import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, orderTotal } from "../support/bookFlow";

const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;
// The seeded hotel's time zone: the deadline is the hotel's calendar day.
const HOTEL_TIME_ZONE = "Europe/Zurich";

/** The hotel's date `offset` days from today (YYYY-MM-DD). */
function hotelDay(offset: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOTEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const day = new Date(`${today}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}
/** "Fri, 23 Oct 2026", as the checkout words a date. */
const shown = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

// VAY-2347: a stay tomorrow on a rate with free cancellation until 3 days before arrival. That
// deadline passed two days ago, so neither step may promise free cancellation, and the times read
// as local hotel time with the hotel's country, not a time zone's name.
for (const width of [1440, 390]) {
  test(`says free cancellation has ended for a stay tomorrow at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openDetails(page, { checkIn: hotelDay(1), checkOut: hotelDay(2), freeDays: 3 });
    const ended = `ree cancellation ended on ${shown(hotelDay(-2))}`;

    const rateTerms = page.getByRole("region", { name: "Room and rate terms" });
    await expect(rateTerms).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`details-${width}.png`), fullPage: true });
    // Soft, so a run on the old code still reaches the payment step's screenshot.
    await expect.soft(rateTerms).toContainText(`Cancellation: f${ended}.`);
    await expect.soft(rateTerms).not.toContainText("days before arrival");
    const rules = page.getByRole("region", { name: "Guest rules" });
    await expect.soft(rules).toContainText("All times are local hotel time (Switzerland).");
    await expect.soft(rules).not.toContainText("Central European Time");

    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(orderTotal(page)).toHaveText("€240");
    await page.getByRole("button", { name: "Read the room and rate terms" }).click();
    await page.getByRole("button", { name: "Read our guest rules" }).click();
    const cancellation = page.getByRole("region", { name: "Cancellation" });
    await expect(cancellation).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`payment-${width}.png`), fullPage: true });
    await expect.soft(cancellation).toContainText(`F${ended}.`);
    await expect.soft(cancellation).not.toContainText("days before arrival");
    await expect
      .soft(page.getByRole("region", { name: "Room 1 terms" }))
      .toContainText(
        `Free cancellation deadline: ${shown(hotelDay(-2))} (3 days before arrival). It has passed`,
      );
    await expect
      .soft(page.getByRole("region", { name: "Guest rules" }))
      .toContainText("All times are local hotel time (Switzerland).");
  });
}

test("words a deadline still ahead as the hotel's date", async ({ page }) => {
  await openDetails(page, { checkIn: hotelDay(20), checkOut: hotelDay(21), freeDays: 3 });
  const until = shown(hotelDay(17));
  await expect(page.getByRole("region", { name: "Room and rate terms" })).toContainText(
    `Cancellation: free until the end of ${until}, local hotel time.`,
  );
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("region", { name: "Cancellation" })).toContainText(
    `Free until the end of ${until}, local hotel time.`,
  );
});

async function openDetails(
  page: Page,
  stay: { checkIn: string; checkOut: string; freeDays: number },
) {
  // Analytics choice already made, so the consent banner doesn't cover the steps.
  await page.addInitScript(
    ({ slug, version }) => {
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version, analytics: false }),
      );
    },
    { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
  );
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        showAddonsStep: true,
        payAtPropertyEnabled: true,
        onlineCardPayment: false,
        freeCancellationDays: stay.freeDays,
        phoneRequired: true,
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
  let issuedQuote: { quoteId: string; issuedAt: string; expiresAt: string } | null = null;
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    const quote = {
      version: "public-booking-quote.v1",
      quoteId: "55555555-5555-4555-8555-555555555555",
      replayed: false,
      checkIn: selection.checkIn,
      checkOut: selection.checkOut,
      currency: "EUR",
      paymentMethod,
      acceptanceMode: "instant",
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
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
        cancellation: {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: stay.freeDays,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        },
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
        propertyTimeZone: HOTEL_TIME_ZONE,
        choices: {
          defaultGuestLanguage: "en",
          childrenEnabled: true,
          adultAgeThreshold: 12,
          phoneRequired: true,
          arrivalTimeEnabled: false,
          specialRequestsEnabled: false,
          checkInTime: "15:00",
          checkOutTime: "11:00",
        },
      },
    }),
  );

  await page.goto(
    `/en/book?slug=${SEEDED_BOOKING_SLUG}&checkIn=${stay.checkIn}&checkOut=${stay.checkOut}`,
  );
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Our guest rules" })).toBeVisible();
}
