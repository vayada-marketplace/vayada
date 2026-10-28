import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, orderTotal } from "../support/bookFlow";

const offerKey = `pricing-offer.v2:${"d".repeat(64)}`;
// The seeded hotel's time zone: the deadline is the hotel's calendar day.
const HOTEL_TIME_ZONE = "Europe/Zurich";

/** `date` moved by `offset` days (YYYY-MM-DD). */
function shift(date: string, offset: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}
/** The hotel's date `offset` days from today. Each test reads it once, so a run across the hotel's
 * midnight still expects dates that belong together. */
function hotelDay(offset: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOTEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return shift(today, offset);
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
// deadline passed two days ago, so the payment step must not promise free cancellation, and the
// times read as local hotel time with the hotel's country, not a time zone's name. VAY-2392: booked
// now, it was never refundable: the policy says so and why, and so does the consent.
for (const width of [1440, 390]) {
  test(`says a stay tomorrow can't be refunded at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const checkIn = hotelDay(1);
    await openDetails(page, { checkIn, checkOut: shift(checkIn, 1), freeDays: 3 });
    const deadline = shown(shift(checkIn, -3));

    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(orderTotal(page)).toHaveText("€240");
    const policy = page.getByRole("table", { name: "Cancellation policy" });
    await expect(policy).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`payment-${width}.png`), fullPage: true });
    // The amber badge, the row that applies now and the note all say it can't be refunded.
    const before = page.getByRole("region", { name: "Before you book" });
    await expect(before.getByText("Non-refundable", { exact: true })).toBeVisible();
    await expect(policy.getByRole("row", { name: /From now until check-in/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // The ended free row stays, dated without this year's year ("Until Mon 26 Oct").
    const dayMonth = deadline.replace(/^\w+, /, "").replace(/ \d{4}$/, "");
    await expect(
      policy.getByRole("row", { name: new RegExp(`^Until .*${dayMonth}`) }),
    ).toBeVisible();
    // The note sits under the table, in the policy's box.
    await expect(before).toContainText(
      "You’re booking less than 3 days before arrival, so this booking can’t be cancelled for free. If you cancel or don’t arrive, you pay the full amount.",
    );
    await expect(before).not.toContainText("Free cancellation ended");
    await expect(before).toContainText("All times are local hotel time (Switzerland).");
    // The consent says it first.
    await expect(
      page.getByRole("checkbox", {
        name: /^I understand this booking is non-refundable\. If I cancel or don’t arrive, the full stay is charged\. I agree to the cancellation policy/,
      }),
    ).toBeVisible();
  });
}

test("words a deadline still ahead as the hotel's date", async ({ page }) => {
  const checkIn = hotelDay(20);
  await openDetails(page, { checkIn, checkOut: shift(checkIn, 1), freeDays: 3 });
  const until = shown(shift(checkIn, -3));
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
  const policy = page.getByRole("table", { name: "Cancellation policy" });
  await expect(policy.getByRole("row", { name: /Until the end of/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByRole("region", { name: "Before you book" })).toContainText(
    `Free cancellation until the end of ${until}, local hotel time.`,
  );
  // A refundable stay's consent has no non-refundable sentence (VAY-2392).
  await expect(
    page.getByRole("checkbox", { name: /^I agree to the cancellation policy/ }),
  ).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Who’s staying?" })).toBeVisible();
}
