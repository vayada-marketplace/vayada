import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { fillGuestDetails, orderTotal, paymentOption } from "../support/bookFlow";

// VAY-2195: the old booking pages' steps on pricing v2: a room card's choice opens at Extras,
// then the guest's details, then payment, then the booking's confirmation page.
const offerKey = `pricing-offer.v2:${"c".repeat(64)}`;
const breakfast = "33333333-3333-4333-8333-333333333333";
const lateCheckOut = "44444444-4444-4444-8444-444444444444";
const reference = "VAY-66666666666646668666666666666666";
const STAY = `/book?checkIn=2026-11-06&checkOut=2026-11-08&adults=2&offer=${offerKey}`;

async function mockFlow(
  page: Page,
  {
    extras = true,
    lateCheckOutNotice = null as { leadTimeHours: number; bookableFrom: string | null } | null,
  } = {},
) {
  await mockBookingApis(page);
  const config = {
    addons: [
      {
        id: breakfast,
        description: "Fresh bread and coffee on the terrace.",
        price: 18,
        category: "dining",
      },
      {
        id: lateCheckOut,
        description: "Keep your room until 14:00.",
        price: 30,
        category: "other",
      },
    ],
    payAtPropertyEnabled: true,
    bookingPagePaymentMethods: ["pay_at_property", "card"],
    termsText: "Quiet hours are 22:00–07:00.",
  };
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({ json: config }),
  );
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "deluxe",
            name: "Deluxe Double Room",
            offers: [{ publicOfferKey: offerKey, currency: "EUR", mealPlan: "room_only" }],
          },
        ],
      },
    }),
  );
  await page.route("**/pricing-addons", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-addons.v1",
        addons: extras
          ? [
              {
                id: breakfast,
                name: "Garden breakfast",
                currency: "EUR",
                pricingModel: "per_guest_night",
                maxQuantity: 1,
                maxGuests: null,
              },
              {
                id: lateCheckOut,
                name: "Late check-out",
                currency: "EUR",
                pricingModel: "per_stay",
                maxQuantity: 1,
                maxGuests: null,
                ...lateCheckOutNotice,
              },
            ]
          : [],
      },
    }),
  );
  const quotes = new Map<string, { issuedAt: string; expiresAt: string }>();
  const unit: Record<string, number> = { [breakfast]: 1800, [lateCheckOut]: 3000 };
  // A test can refuse the next prices (all of them, or one way to pay's), fail them with another
  // status, or make them run out quickly.
  const prices = {
    refuse: false as boolean | string,
    // A refusal with a code (e.g. ADDON_NEEDS_NOTICE) answers once.
    code: "",
    status: 422,
    lastsMs: 600_000,
    asked: [] as string[],
  };
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    prices.asked.push(paymentMethod);
    if (prices.refuse === true || prices.refuse === paymentMethod) {
      const code = prices.code;
      if (code) Object.assign(prices, { refuse: false, code: "" });
      return route.fulfill({
        status: prices.status,
        json: { detail: "Room is not available.", ...(code ? { code } : {}) },
      });
    }
    const quoteId = `55555555-5555-4555-8555-${String(quotes.size + 1).padStart(12, "0")}`;
    const times = {
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + prices.lastsMs).toISOString(),
    };
    quotes.set(quoteId, times);
    const addonLines = selection.addons.map(
      (addon: { id: string; people: unknown[] | null; dates: string[]; quantity: number }) => ({
        kind: "addon",
        selectionId: null,
        amountMinor: String(
          unit[addon.id]! * (addon.people?.length ?? addon.quantity) * addon.dates.length,
        ),
      }),
    );
    const total =
      26800 +
      addonLines.reduce(
        (sum: number, line: { amountMinor: string }) => sum + Number(line.amountMinor),
        0,
      );
    return route.fulfill({
      json: {
        version: "public-booking-quote.v1",
        quoteId,
        replayed: false,
        checkIn: selection.checkIn,
        checkOut: selection.checkOut,
        currency: "EUR",
        paymentMethod,
        acceptanceMode: "instant",
        ...times,
        totalMinor: String(total),
        dueNowMinor: paymentMethod === "card" ? String(total) : "0",
        dueLaterMinor: paymentMethod === "card" ? "0" : String(total),
        lines: [
          { kind: "room", selectionId: selection.rooms[0].selectionId, amountMinor: "26800" },
          ...addonLines,
        ],
        rooms: selection.rooms.map((room: { selectionId: string }) => ({
          selectionId: room.selectionId,
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          payment: { kind: "full", acceptedMethods: ["pay_at_property", "card"] },
        })),
      },
    });
  });
  await page.route("**/bookings/quotes/*/guest-disclosure", (route) => {
    const quoteId = route.request().url().split("/quotes/")[1]!.split("/")[0]!;
    return route.fulfill({
      json: {
        version: "public-quote-guest-disclosure.v1",
        quoteId,
        quoteEvidenceId: `sha256:${"a".repeat(64)}`,
        guestPolicyEvidenceId: `sha256:${"b".repeat(64)}`,
        ...quotes.get(quoteId),
        checkedAt: new Date().toISOString(),
        propertyTimeZone: "Europe/Berlin",
        choices: {
          defaultGuestLanguage: "en",
          childrenEnabled: true,
          adultAgeThreshold: 18,
          phoneRequired: true,
          arrivalTimeEnabled: true,
          specialRequestsEnabled: true,
          checkInTime: "15:00",
          checkInUntil: "22:00",
          checkOutTime: "11:00",
        },
      },
    });
  });
  const accepted: unknown[] = [];
  await page.route("**/bookings/quotes/*/accept", (route) => {
    accepted.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        kind: "accepted",
        bookingId: "66666666-6666-4666-8666-666666666666",
        bookingReference: reference,
        acceptanceId: "77777777-7777-4777-8777-777777777777",
        acceptedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
      },
    });
  });
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`, (route) =>
    route.fulfill({
      json: {
        id: "66666666-6666-4666-8666-666666666666",
        bookingReference: reference,
        status: "confirmed",
        paymentStatus: "unpaid",
        paymentMethod: "pay_at_property",
        hotelName: "Hotel Alpenrose",
        roomName: "Deluxe Double Room",
        guestFirstName: "Ada",
        guestLastName: "Lovelace",
        guestEmail: "ada@example.test",
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        nights: 2,
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        currency: "EUR",
        totalAmount: 370,
        balanceAmount: 370,
        createdAt: new Date().toISOString(),
        confirmationToken: "t".repeat(48),
        confirmationTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
  );
  await page.route("**/change-request**", (route) => route.fulfill({ status: 404, json: {} }));
  return { accepted, prices };
}

for (const width of [1440, 390]) {
  test(`books through Extras, Details and Payment and opens the confirmation at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [/\/change-request/],
    });
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    const { accepted } = await mockFlow(page);
    await page.goto(STAY);

    // A room card's complete choice opens at Extras.
    await expect(page).toHaveURL(/[?&]step=extras/);
    await expect(page.getByRole("heading", { name: "Enhance Your Stay" })).toBeVisible();
    const extras = page.getByRole("region", { name: "Optional extras" });
    const total = page.getByRole("status", { name: "Your stay total" });
    await expect(total).toContainText("€268");
    await expect(extras).toContainText("€18 / person / night");
    await extras.getByRole("button", { name: "Add Garden breakfast" }).click();
    await expect(total).toContainText("€340");
    await extras.getByRole("button", { name: "Add Late check-out" }).click();
    const next = page.getByRole("button", { name: "Continue to your details" });
    await expect(next).toBeDisabled();
    await expect(page.getByText("Choose a day for Late check-out, or remove it.")).toBeVisible();
    // Without its day the extra can't be priced: the totals ask for it instead of loading.
    await expect(total).toHaveText("Choose a day to see your total");
    await expect(extras.getByText("Extras total").locator("..")).toContainText("Choose a day");
    await extras.getByRole("button", { name: "Late check-out on Sun 8 Nov" }).click();
    await expect(total).toContainText("€370");
    await expect(extras.getByText("Your extras (2)")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`extras-${width}.png`), fullPage: true });
    await next.click();

    // Details: the guest's details survive a refresh; Back keeps the extras.
    await expect(page.getByRole("heading", { name: "Guest Information" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Guest rules" })).toContainText(
      "From 15:00 until 22:00",
    );
    // The hotel's time zone by name, not as an IANA id.
    await expect(page.getByRole("region", { name: "Guest rules" })).toContainText(
      "Times are in Central European Time.",
    );
    await expect(page.getByRole("region", { name: "Our terms & conditions" })).toContainText(
      "Quiet hours",
    );
    await fillGuestDetails(page);
    await page.getByLabel("Special requests (optional)").fill("A quiet room, please.");
    await page.reload();
    await expect(page).toHaveURL(/[?&]step=details/);
    await expect(page.getByLabel("First name")).toHaveValue("Ada");
    await expect(page.getByLabel("Special requests (optional)")).toHaveValue(
      "A quiet room, please.",
    );
    await page.screenshot({ path: testInfo.outputPath(`details-${width}.png`), fullPage: true });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]step=extras/);
    await expect(extras.getByText("Your extras (2)")).toBeVisible();
    await page.goForward();
    await page.getByRole("button", { name: "Continue to payment" }).click();

    // Payment: pay at the hotel by default, the ticks for this price, then Confirm.
    await expect(page.getByRole("heading", { name: "Secure Payment" })).toBeVisible();
    await expect(paymentOption(page, "pay_at_property")).toHaveAttribute("aria-checked", "true");
    await expect(orderTotal(page)).toHaveText("€370");
    const confirm = page.getByRole("button", { name: "Confirm booking" });
    const terms = page.getByLabel("I have read the room and rate terms for this price");
    const rules = page.getByLabel("guest rules for this price");
    const missing = page
      .getByRole("alert")
      .filter({ hasText: "Read and accept both the room terms and guest rules to book." });
    // VAY-2306: Confirm before ticking books nothing; it marks both boxes and goes to the first.
    await confirm.click();
    await expect(missing).toBeVisible();
    await expect(terms).toHaveAttribute("aria-invalid", "true");
    await expect(rules).toHaveAttribute("aria-invalid", "true");
    await expect(terms).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`payment-missing-ticks-${width}.png`),
      fullPage: true,
    });
    // Back to the details and on again: the boxes start without the mark until the next press.
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(terms).toBeVisible();
    await expect(missing).toHaveCount(0);
    await expect(terms).not.toHaveAttribute("aria-invalid", "true");
    await confirm.click();
    await expect(missing).toBeVisible();
    await expect(terms).toBeFocused();
    await page.keyboard.press("Space");
    await expect(terms).toBeChecked();
    await expect(terms).not.toHaveAttribute("aria-invalid", "true");
    await expect(rules).toHaveAttribute("aria-invalid", "true");
    // The whole tile ticks its box, not only the box itself.
    const tile = rules.locator("xpath=ancestor::div[contains(@class, 'border-2')][1]");
    const { width: tileWidth } = (await tile.boundingBox())!;
    await tile.click({ position: { x: tileWidth - 12, y: 12 } });
    await expect(rules).toBeChecked();
    await expect(missing).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`payment-${width}.png`), fullPage: true });
    // Another way to pay is a new price: its terms are ticked afresh.
    await paymentOption(page, "card").click();
    await expect(page.getByRole("button", { name: "Continue to card payment" })).toBeVisible();
    await expect(terms).not.toBeChecked();
    await expect(rules).not.toBeChecked();
    await expect(missing).toHaveCount(0);
    await paymentOption(page, "pay_at_property").click();
    await page.getByLabel("I have read the room and rate terms for this price").check();
    await page.getByLabel("guest rules for this price").check();
    await confirm.click();

    await expect(page).toHaveURL(new RegExp(`/booking/${reference}$`));
    // VAY-2307: the long reference reads in groups of four.
    await expect(page.getByText("VAY-6666 6666 6666 4666 8666 6666 6666 6666")).toBeVisible();
    // The choice keeps the name the steps showed (VAY-2190 plain names).
    await expect(page.getByText("Deluxe Double Room · Room only")).toBeVisible();
    await expect(page.getByText("Due at the hotel", { exact: true }).locator("..")).toContainText(
      "€370",
    );
    // The page shows the server's answer, not the fallback this booking knows (its id is empty).
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem("lastBooking") ?? "{}").id),
    ).toBe("66666666-6666-4666-8666-666666666666");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      guest: { firstName: "Ada", lastName: "Lovelace", specialRequests: "A quiet room, please." },
    });
    // The draft is gone: the steps start again from the hotel's hand-off.
    expect(
      await page.evaluate(
        (slug) => sessionStorage.getItem(`bookFlow:${slug}`),
        SEEDED_BOOKING_SLUG,
      ),
    ).toBeNull();
    await page.screenshot({ path: testInfo.outputPath(`confirmed-${width}.png`), fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await assertHealthy();
  });
}

// VAY-2232: the stay starts on 2026-11-06; the hotel needs 24 hours' notice for late check-out.
test("shows an extra that needs more notice than the stay gives as unavailable", async ({
  page,
}, testInfo) => {
  await mockFlow(page, { lateCheckOutNotice: { leadTimeHours: 24, bookableFrom: "2026-11-07" } });
  await page.goto(STAY);
  const extras = page.getByRole("region", { name: "Optional extras" });
  const late = extras.getByRole("article", { name: "Late check-out" });
  await expect(late.getByRole("button", { name: "Add Late check-out" })).toBeDisabled();
  await expect(late).toContainText("Needs 24 hours’ notice");
  await extras.getByRole("button", { name: "Add Garden breakfast" }).click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€340");
  await page.screenshot({ path: testInfo.outputPath("extras-needs-notice.png"), fullPage: true });
  // In the guest's language.
  await page.goto(`/de${STAY}`);
  await expect(
    page.getByRole("article", { name: "Late check-out" }).getByText("Nur mit 24 Stunden Vorlauf"),
  ).toBeVisible();
});

test("offers an extra with a lead time from its first bookable check-in date", async ({
  page,
}, testInfo) => {
  await mockFlow(page, { lateCheckOutNotice: { leadTimeHours: 48, bookableFrom: "2026-11-06" } });
  await page.goto(STAY);
  const late = page.getByRole("article", { name: "Late check-out" });
  await expect(late.getByRole("button", { name: "Add Late check-out" })).toBeEnabled();
  await expect(late).not.toContainText("notice");
  await page.screenshot({ path: testInfo.outputPath("extras-enough-notice.png"), fullPage: true });
});

test("prices the stay again without extras when an extra's notice ran out meanwhile", async ({
  page,
}) => {
  const { prices } = await mockFlow(page);
  let catalogues = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/pricing-addons")) catalogues += 1;
  });
  await page.goto(STAY);
  const extras = page.getByRole("region", { name: "Optional extras" });
  const total = page.getByRole("status", { name: "Your stay total" });
  await expect(total).toContainText("€268");
  // React's dev mode can load the extras twice on the way in; count from here.
  const loaded = catalogues;
  Object.assign(prices, { refuse: true, code: "ADDON_NEEDS_NOTICE" });
  await extras.getByRole("button", { name: "Add Garden breakfast" }).click();
  // The extra is dropped, the extras load again and the stay is priced without them.
  await expect.poll(() => catalogues).toBeGreaterThan(loaded);
  await expect(extras.getByText("Your extras (1)")).toHaveCount(0);
  await expect(total).toContainText("€268");
  await expect(page.getByText("We couldn't price this selection")).toHaveCount(0);
});

test("skips Extras for a hotel without extras", async ({ page }) => {
  await mockFlow(page, { extras: false });
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=details/);
  const steps = page.locator("main").getByText(/^(Rooms|Extras|Details|Payment)$/);
  await expect(steps).toHaveText(["Rooms", "Details", "Payment"]);
  await page.getByRole("button", { name: "Back to rooms" }).click();
  await expect(page).toHaveURL(/\/\?checkIn=2026-11-06&checkOut=2026-11-08&adults=2$/);
});

test("opens the first step a deep link can't skip", async ({ page }) => {
  await mockFlow(page);
  await page.goto(`${STAY}&step=payment`);
  // No details yet: the guest lands on the details step.
  await expect(page).toHaveURL(/[?&]step=details/);
  await expect(page.getByRole("heading", { name: "Guest Information" })).toBeVisible();
});

test("a selection we can't price stops at Extras, above the buttons", async ({ page }) => {
  const { prices } = await mockFlow(page);
  prices.refuse = true;
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=extras/);
  const notice = page.getByRole("alert").filter({ hasText: "We couldn't price this selection" });
  const next = page.getByRole("button", { name: "Continue to your details" });
  // Paying at the hotel is refused, then paying by card: only then does the notice stay.
  await expect.poll(() => prices.asked.includes("card")).toBe(true);
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Choose another room" })).toBeVisible();
  await expect(next).toBeDisabled();
  expect((await notice.boundingBox())!.y).toBeLessThan((await next.boundingBox())!.y);
  // Another choice is priced again and the step continues.
  prices.refuse = false;
  await page
    .getByRole("region", { name: "Optional extras" })
    .getByRole("button", { name: "Add Garden breakfast" })
    .click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€340");
  await expect(notice).toHaveCount(0);
  await expect(next).toBeEnabled();
});

test("a refused updated price keeps the stay on the payment step", async ({ page }) => {
  const { prices } = await mockFlow(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Continue to your details" }).click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  // A card price that runs out, then the updated price is refused.
  prices.lastsMs = 3_000;
  await paymentOption(page, "card").click();
  await expect(orderTotal(page)).toHaveText("€268");
  await expect(page.getByText("This price has expired. Get an updated price.")).toBeVisible({
    timeout: 15_000,
  });
  prices.refuse = true;
  await page.getByRole("button", { name: "Get an updated price" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "We couldn't price this selection" }),
  ).toBeVisible();
  // Nothing is left to accept, and the summary keeps the stay with its expired price.
  await expect(page.getByRole("region", { name: "Before you book" })).toHaveCount(0);
  await expect(orderTotal(page)).toHaveText("€268");
  await expect(orderTotal(page)).toHaveClass(/line-through/);
  await expect(
    page.getByRole("complementary", { name: "Order Summary" }).getByText(/This price expired at/),
  ).toBeVisible();
});

test("a price that failed to load can be tried again", async ({ page }) => {
  const { prices } = await mockFlow(page);
  Object.assign(prices, { refuse: true, status: 503 });
  await page.goto(STAY);
  const notice = page.getByRole("alert").filter({ hasText: "We couldn't price this selection" });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to your details" })).toBeDisabled();
  prices.refuse = false;
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€268");
  await expect(page.getByRole("button", { name: "Continue to your details" })).toBeEnabled();
});

test("a way to pay the new choices don't take goes back to the hotel's own", async ({ page }) => {
  const { prices } = await mockFlow(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Continue to your details" }).click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await paymentOption(page, "card").click();
  await expect(orderTotal(page)).toHaveText("€268");
  // Back at Extras, the new choice can't be paid by card: it is priced to pay at the hotel.
  prices.refuse = "card";
  await page.getByRole("button", { name: "Back to your details" }).click();
  await page.getByRole("button", { name: "Back to extras" }).click();
  await page
    .getByRole("region", { name: "Optional extras" })
    .getByRole("button", { name: "Add Garden breakfast" })
    .click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€340");
  await page.getByRole("button", { name: "Continue to your details" }).click();
  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(paymentOption(page, "pay_at_property")).toHaveAttribute("aria-checked", "true");
});
