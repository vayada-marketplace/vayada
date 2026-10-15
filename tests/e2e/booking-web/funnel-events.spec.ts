import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, mockStayPrices, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { fillGuestDetails, mockAnyPrice } from "../support/bookFlow";

// VAY-2197: the booking steps report where guests leave, only with analytics consent and never
// with anything about the guest.
const offerKey = `pricing-offer.v2:${"c".repeat(64)}`;
const reference = "VAY-66666666666646668666666666666666";
const HOTEL = "/?checkIn=2026-11-06&checkOut=2026-11-08&adults=2";

type Sent = { eventType: string; sessionId: string; metadata: Record<string, unknown> };

async function mockFunnel(page: Page, { extras = true, refusePrices = false } = {}) {
  await mockBookingApis(page);
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "deluxe",
            name: "Deluxe Double Room",
            occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
            offers: [{ publicOfferKey: offerKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  await mockStayPrices(page, { deluxe: { [offerKey]: "20000" } });
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-addons.v1",
        addons: extras
          ? [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "Garden breakfast",
                currency: "EUR",
                pricingModel: "per_guest_night",
                maxQuantity: 1,
                maxGuests: null,
              },
            ]
          : [],
      },
    }),
  );
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        addons: [],
        payAtPropertyEnabled: true,
        bookingPagePaymentMethods: ["pay_at_property"],
        termsText: null,
      },
    }),
  );
  await mockAnyPrice(page);
  if (refusePrices)
    await page.route("**/bookings/quote", (route) =>
      route.fulfill({ status: 422, json: { detail: "Room is not available." } }),
    );
  await page.route("**/bookings/quotes/*/accept", (route) =>
    route.fulfill({
      json: {
        kind: "accepted",
        bookingId: "66666666-6666-4666-8666-666666666666",
        bookingReference: reference,
        acceptanceId: "77777777-7777-4777-8777-777777777777",
        acceptedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`, (route) =>
    route.fulfill({ status: 404, json: { detail: "Not found." } }),
  );
  await page.route("**/change-request**", (route) => route.fulfill({ status: 404, json: {} }));
  // Every event request the page makes, with whether it carried the page's address.
  const sent: (Sent & { referer: string | null; body: string })[] = [];
  await page.route("**/api/booking-web/events", async (route) => {
    const request = route.request();
    sent.push({
      ...request.postDataJSON(),
      referer: await request.headerValue("referer"),
      body: request.postData() ?? "",
    });
    await route.fulfill({ status: 204 });
  });
  return sent;
}

function saveChoice(page: Page, analytics: boolean) {
  return page.addInitScript(
    ({ slug, analytics }) =>
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version: 1, analytics }),
      ),
    { slug: SEEDED_BOOKING_SLUG, analytics },
  );
}

/** The events in the order sent; React's development double effects may repeat one. */
function funnel(sent: Sent[]) {
  const ordered = [...sent].sort(
    (a, b) => Number(a.metadata.funnelSequence) - Number(b.metadata.funnelSequence),
  );
  const events = ordered.map(({ eventType, metadata }) => {
    const properties: Record<string, unknown> = { ...metadata };
    delete properties.funnelVersion;
    delete properties.funnelSequence;
    return [eventType, properties] as const;
  });
  return events.filter(
    (event, index) => JSON.stringify(event) !== JSON.stringify(events[index - 1]),
  );
}

/** From the hotel page's room card, through Extras and Details, to a booked stay. */
async function book(page: Page, { extras = true } = {}) {
  const card = page.getByTestId("room-card-deluxe");
  await card.getByRole("button", { name: "View Details" }).click();
  await page.getByRole("button", { name: "Close room details" }).click();
  await page.getByTestId("select-rate-deluxe").click();
  if (extras) {
    await expect(page).toHaveURL(/[?&]step=extras/);
    await page
      .getByRole("region", { name: "Optional extras" })
      .getByRole("button", { name: "Add Garden breakfast" })
      .click();
    await page.getByRole("button", { name: "Continue to your details" }).click();
  }
  await expect(page).toHaveURL(/[?&]step=details/);
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.getByRole("heading", { name: "Secure Payment" })).toBeVisible();
  await page.getByLabel("I have read the room and rate terms for this price").check();
  await page.getByLabel("guest rules for this price").check();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page).toHaveURL(new RegExp(`/booking/${reference}$`));
}

/** One session, a new sequence number per event, and nothing about the guest or the stay. */
function expectPrivate(sent: (Sent & { referer: string | null; body: string })[]) {
  expect(new Set(sent.map((event) => event.sessionId)).size).toBe(1);
  const sequences = sent.map((event) => event.metadata.funnelSequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  for (const event of sent) {
    expect(event.referer).toBeNull();
    expect(event.body).not.toMatch(/Ada|Lovelace|example\.test|\+49|VAY-|2026-11|checkIn/);
  }
}

test("a first-time guest who allows analytics is counted from the hotel page to the booking", async ({
  page,
}) => {
  const sent = await mockFunnel(page);
  await page.goto(HOTEL);
  await expect(
    page.getByRole("heading", { name: "Optional analytics", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("room-card-deluxe")).toBeVisible();
  expect(sent).toEqual([]);
  await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
  await book(page);

  await expect.poll(() => funnel(sent).at(-1)?.[0]).toBe("booking_completed");
  expect(funnel(sent)).toEqual([
    ["page_visit", {}],
    ["room_viewed", { roomTypeId: "deluxe" }],
    ["rate_selected", { entry: "room_card" }],
    ["step_viewed", { step: "extras" }],
    ["addons_step_passed", { extrasShown: true, extrasChosen: true }],
    ["step_viewed", { step: "details" }],
    ["details_completed", {}],
    ["step_viewed", { step: "payment" }],
    ["complete_booking_clicked", { paymentMethod: "pay_at_property", mode: "instant" }],
    ["booking_completed", { paymentMethod: "pay_at_property", outcome: "confirmed" }],
  ]);
  expectPrivate(sent);
});

test("a stay without an Extras step still passes the extras stage", async ({ page }) => {
  await saveChoice(page, true);
  const sent = await mockFunnel(page, { extras: false });
  await page.goto(HOTEL);
  await book(page, { extras: false });

  await expect.poll(() => funnel(sent).at(-1)?.[0]).toBe("booking_completed");
  expect(funnel(sent).slice(0, 6)).toEqual([
    ["page_visit", {}],
    ["room_viewed", { roomTypeId: "deluxe" }],
    ["rate_selected", { entry: "room_card" }],
    ["addons_step_passed", { extrasShown: false, extrasChosen: false }],
    ["step_viewed", { step: "details" }],
    ["details_completed", {}],
  ]);
  expectPrivate(sent);
});

test("a refused price is reported once, without the guest's details", async ({ page }) => {
  await saveChoice(page, true);
  const sent = await mockFunnel(page, { refusePrices: true });
  await page.goto(HOTEL);
  await page.getByTestId("select-rate-deluxe").click();
  await expect(page.getByText("We couldn't price this selection.")).toBeVisible();
  await expect
    .poll(() => funnel(sent).filter(([type]) => type === "booking_error"))
    .toEqual([["booking_error", { step: "extras", reason: "price_refused" }]]);
  expectPrivate(sent);
});

for (const choice of ["rejected", "unanswered"] as const) {
  test(`sends nothing when analytics is ${choice}`, async ({ page }) => {
    if (choice === "rejected") await saveChoice(page, false);
    const sent = await mockFunnel(page);
    await page.goto(HOTEL);
    if (choice === "unanswered") await page.keyboard.press("Escape");
    await book(page);
    expect(sent).toEqual([]);
    expect(
      await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("sid"))),
    ).toEqual([]);
  });
}
