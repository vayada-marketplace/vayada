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
    methods = ["pay_at_property", "card"],
    earliestArrival = {} as Record<string, string>,
    // VAY-2348: the hotel's booking window per way to pay, as arrival dates.
    arrivalWindows = {} as Record<string, { from?: string; through?: string }>,
    // The ways the rate takes, as the catalog names them (VAY-2309); older APIs send none.
    offerPaymentMethods = undefined as string[] | undefined,
    // VAY-2391: more extras, each with when it happens and its price.
    moreExtras = [] as {
      id: string;
      name: string;
      pricingModel: string;
      scheduleMode: string;
      bookableWeekdays?: number[];
      price: number;
    }[],
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
        duration: "07:00–10:30",
        location: "Garden terrace",
      },
      {
        id: lateCheckOut,
        description: "Keep your room until 14:00.",
        price: 30,
        category: "other",
      },
      ...moreExtras.map((extra) => ({
        id: extra.id,
        description: "",
        price: extra.price,
        category: "other",
      })),
    ],
    payAtPropertyEnabled: true,
    bookingPagePaymentMethods: methods,
    manualPaymentEarliestArrival: earliestArrival,
    paymentMethodArrivalWindows: arrivalWindows,
    termsText: "Quiet hours are 22:00–07:00.",
  };
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({ json: config }),
  );
  // A test can change the rate's ways to pay later (the hotel changed them meanwhile).
  const catalog = { paymentMethods: offerPaymentMethods };
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "deluxe",
            name: "Deluxe Double Room",
            offers: [
              {
                publicOfferKey: offerKey,
                currency: "EUR",
                mealPlan: "room_only",
                ...(catalog.paymentMethods && { paymentMethods: catalog.paymentMethods }),
              },
            ],
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
                // VAY-2391: as the live API sends them.
                scheduleMode: "daily",
                bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
              },
              {
                id: lateCheckOut,
                name: "Late check-out",
                currency: "EUR",
                pricingModel: "per_stay",
                maxQuantity: 1,
                maxGuests: null,
                scheduleMode: "guest_pick",
                bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
                ...lateCheckOutNotice,
              },
              ...moreExtras.map((extra) => ({
                id: extra.id,
                name: extra.name,
                currency: "EUR",
                pricingModel: extra.pricingModel,
                maxQuantity: 1,
                maxGuests: null,
                scheduleMode: extra.scheduleMode,
                bookableWeekdays: extra.bookableWeekdays ?? [1, 2, 3, 4, 5, 6, 7],
              })),
            ]
          : [],
      },
    }),
  );
  const quotes = new Map<string, { issuedAt: string; expiresAt: string }>();
  const unit: Record<string, number> = {
    [breakfast]: 1800,
    [lateCheckOut]: 3000,
    ...Object.fromEntries(moreExtras.map((extra) => [extra.id, extra.price * 100])),
  };
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
    // VAY-2391: an extra the hotel dates sends no day; a per-night one counts every night.
    const nights = (Date.parse(selection.checkOut) - Date.parse(selection.checkIn)) / 86_400_000;
    const addonLines = selection.addons.map(
      (addon: {
        id: string;
        people: unknown[] | null;
        dates: string[] | null;
        quantity: number;
      }) => ({
        kind: "addon",
        selectionId: null,
        amountMinor: String(
          unit[addon.id]! *
            (addon.people?.length ?? addon.quantity) *
            (addon.dates?.length ?? (addon.id === breakfast ? nights : 1)),
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
  return { accepted, prices, catalog };
}

for (const width of [1440, 390]) {
  test(`books through Extras, Details and Payment and opens the confirmation at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [/\/change-request/],
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const { accepted } = await mockFlow(page);
    await page.goto(STAY);

    // A room card's complete choice opens at Extras.
    await expect(page).toHaveURL(/[?&]step=extras/);
    await expect(page.getByRole("heading", { name: "Enhance Your Stay" })).toBeVisible();
    const extras = page.getByRole("region", { name: "Optional extras" });
    const total = page.getByRole("status", { name: "Your stay total" });
    await expect(total).toContainText("€268");
    await expect(extras).toContainText("€18 / person / night");
    // VAY-2416: "Your stay" carries Continue; without extras it goes on without them.
    const stay = page.getByRole("complementary", { name: "Your stay" });
    await expect(stay.getByRole("button", { name: "Continue without extras" })).toBeVisible();
    await expect(stay).not.toContainText("Garden breakfast");
    await extras.getByRole("button", { name: "Add Garden breakfast" }).click();
    // Every night of the stay, nothing to choose.
    await expect(extras).toContainText("Every day of your stay2 nights");
    await expect(total).toContainText("€340");
    await extras.getByRole("button", { name: "Add Late check-out" }).click();
    const next = page.getByRole("button", { name: "Continue to your details" });
    // Without its day the extra can't be priced: the total asks for it instead of loading.
    await expect(total).toHaveText("Choose a day to see your total");
    await expect(stay).toContainText("Late check-outChoose a day");
    // Continue says what's missing and marks the card.
    await next.click();
    await expect(page.getByText("Choose a day for Late check-out, or remove it.")).toBeVisible();
    await expect(extras.getByText("Choose a day to continue")).toBeVisible();
    await expect(page).toHaveURL(/[?&]step=extras/);
    // Only the nights of the stay: never the check-out day.
    await expect(extras.getByRole("button", { name: "Late check-out on Sun 8 Nov" })).toHaveCount(
      0,
    );
    await extras.getByRole("button", { name: "Late check-out on Sat 7 Nov" }).click();
    await expect(total).toContainText("€370");
    // Each extra with its price in the card; on a phone behind "Details".
    await expect(stay).toContainText("Garden breakfast€72");
    await expect(stay).toContainText("Late check-out€30");
    await expect(next).toBeInViewport();
    if (width === 390) await stay.getByRole("button", { name: "Details", exact: true }).click();
    await expect(stay.getByText("Garden breakfast")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`extras-list-${width}.png`) });
    if (width === 390) await stay.getByRole("button", { name: "Details", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`extras-${width}.png`), fullPage: true });
    await next.click();

    // Details: the guest's details survive a refresh; Back keeps the extras.
    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    // VAY-2347: only the form; the guest rules and terms are read on the next step.
    await expect(page.getByRole("heading", { name: "Who’s staying?" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Guest rules" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Terms & conditions" })).toHaveCount(0);
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
    await expect(stay).toContainText("Late check-out€30");
    await page.goForward();
    await page.getByRole("button", { name: "Continue to review" }).click();

    // Payment: pay at the hotel by default, one tick for this price, then Confirm (VAY-2347).
    await expect(page.getByRole("heading", { name: "Review & pay" })).toBeVisible();
    await expect(paymentOption(page, "pay_at_property")).toHaveAttribute("aria-checked", "true");
    await expect(orderTotal(page)).toHaveText("€370");
    // Local hotel time with the hotel's country, not a zone's name or IANA id.
    await expect(page.getByRole("region", { name: "Before you book" })).toContainText(
      "All times are local hotel time (Switzerland).",
    );
    await page.getByRole("button", { name: "Guest rules" }).click();
    await expect(page.getByRole("region", { name: "Guest rules" })).toContainText(
      "Check-in from 15:00 until 22:00",
    );
    await page.getByRole("button", { name: "Terms & conditions" }).click();
    await expect(page.getByRole("region", { name: "Terms & conditions" })).toContainText(
      "Quiet hours",
    );
    const confirm = page.getByRole("button", { name: "Confirm booking" });
    const agree = page.getByLabel(/I agree to the cancellation policy/);
    const missing = page
      .getByRole("alert")
      .filter({ hasText: "Please tick the box to confirm your booking." });
    // VAY-2306: Confirm before ticking books nothing; it marks the box and focuses it.
    await confirm.click();
    await expect(missing).toBeVisible();
    await expect(agree).toHaveAttribute("aria-invalid", "true");
    await expect(agree).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`payment-missing-ticks-${width}.png`),
      fullPage: true,
    });
    // Back to the details and on again: the box starts without the mark until the next press.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(agree).toBeVisible();
    await expect(missing).toHaveCount(0);
    await expect(agree).not.toHaveAttribute("aria-invalid", "true");
    await confirm.click();
    await expect(missing).toBeVisible();
    await expect(agree).toBeFocused();
    await page.keyboard.press("Space");
    await expect(agree).toBeChecked();
    await expect(missing).toHaveCount(0);
    // The whole tile ticks its box, not only the box itself.
    await agree.uncheck();
    const tile = agree.locator("xpath=ancestor::div[contains(@class, 'border-2')][1]");
    const { width: tileWidth } = (await tile.boundingBox())!;
    await tile.click({ position: { x: tileWidth - 12, y: 12 } });
    await expect(agree).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`payment-${width}.png`), fullPage: true });
    // Another way to pay is a new price: its terms are agreed to afresh.
    await paymentOption(page, "card").click();
    await expect(page.getByRole("button", { name: "Continue to card details" })).toBeVisible();
    await expect(agree).not.toBeChecked();
    await expect(missing).toHaveCount(0);
    await paymentOption(page, "pay_at_property").click();
    await page.getByLabel(/I agree to the cancellation policy/).check();
    await confirm.click();

    await expect(page).toHaveURL(new RegExp(`/booking/${reference}$`));
    // VAY-2307: the long reference reads in groups of four.
    await expect(page.getByText("VAY-6666 6666 6666 4666 8666 6666 6666 6666")).toBeVisible();
    // The room by its name: its meal and terms have their own lines (VAY-2360).
    await expect(page.getByText("Deluxe Double Room", { exact: true })).toBeVisible();
    await expect(page.getByText("Due at the hotel", { exact: true }).locator("..")).toContainText(
      "€370",
    );
    // VAY-2391: each extra with when it happens.
    const bookedExtras = page.getByTestId("confirmation-addons");
    await expect(bookedExtras.getByRole("listitem")).toHaveText([
      /^Garden breakfast.*6 Nov – 7 Nov$/,
      /^Late check-out.*Sat 7 Nov$/,
    ]);
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

// VAY-2231: a card's details: a popup from md up, a bottom sheet on phones.
for (const width of [1440, 390]) {
  test(`opens an extra's details and adds it from there at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await mockFlow(page, { lateCheckOutNotice: { leadTimeHours: 24, bookableFrom: "2026-11-07" } });
    await page.goto(STAY);
    const breakfastCard = page.getByRole("article", { name: "Garden breakfast" });
    await breakfastCard.getByRole("button", { name: "See details" }).click();
    const details = page.getByRole("dialog", { name: "Garden breakfast" });
    await expect(details).toBeVisible();
    await expect(details).toContainText("07:00–10:30");
    await expect(details).toContainText("Garden terrace");
    await expect(details).toContainText("Fresh bread and coffee on the terrace.");
    const box = (await details.boundingBox())!;
    // A sheet on the phone: full width, down to the bottom of the screen.
    if (width < 400) expect(Math.round(box.width)).toBe(width);
    if (width < 400) expect(Math.round(box.y + box.height)).toBe(844);
    await page.screenshot({ path: testInfo.outputPath(`extra-details-${width}.png`) });
    await details.getByRole("button", { name: "Add", exact: true }).click();
    await expect(details).toBeHidden();
    await expect(
      breakfastCard.getByRole("button", { name: "Fewer for Garden breakfast" }),
    ).toBeVisible();
    await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€340");
    // An extra the stay is too soon for says why, and Escape closes the details.
    await page.getByRole("article", { name: "Late check-out" }).getByText("Late check-out").click();
    const late = page.getByRole("dialog", { name: "Late check-out" });
    await expect(late).toContainText("Needs 24 hours’ notice, so it can’t be added to this stay.");
    await expect(late.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(late).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

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
  await expect(page.getByRole("complementary", { name: "Your stay" })).not.toContainText(
    "Garden breakfast",
  );
  await expect(total).toContainText("€268");
  await expect(page.getByText("We couldn't price this selection")).toHaveCount(0);
});

// VAY-2391: six extras, each scheduled its own way. "Your stay" keeps Continue in view on a 1080p
// screen (VAY-2416) and lists each extra with its price.
test("shows when each extra happens and keeps Continue in view with six extras", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const id = (n: number) => `77777777-7777-4777-8777-00000000000${n}`;
  await mockFlow(page, {
    moreExtras: [
      {
        id: id(1),
        name: "Airport transfer",
        pricingModel: "per_stay",
        scheduleMode: "arrival",
        price: 30,
      },
      {
        id: id(2),
        name: "Sunset dinner",
        pricingModel: "per_guest",
        scheduleMode: "guest_pick",
        bookableWeekdays: [5],
        price: 45,
      },
      {
        id: id(3),
        name: "Welcome bottle",
        pricingModel: "per_stay",
        scheduleMode: "anytime",
        price: 35,
      },
      {
        id: id(4),
        name: "Drop-off",
        pricingModel: "per_stay",
        scheduleMode: "departure",
        price: 25,
      },
    ],
  });
  await page.goto(STAY);
  const extras = page.getByRole("region", { name: "Optional extras" });
  const next = page.getByRole("button", { name: /^Continue (to your details|without extras)$/ });
  await expect(extras.getByRole("article")).toHaveCount(6);
  await expect(next).toBeInViewport();
  const card = (name: string) => extras.getByRole("article", { name });
  for (const name of ["Airport transfer", "Drop-off", "Welcome bottle", "Sunset dinner"])
    await card(name)
      .getByRole("button", { name: `Add ${name}` })
      .click();
  await expect(card("Airport transfer")).toContainText(
    "Fri 6 Nov · your arrival dayScheduled automatically",
  );
  await expect(card("Drop-off")).toContainText("Sun 8 Nov · your departure day");
  await expect(card("Welcome bottle")).toContainText("Anytime during your stayNo date needed");
  // Fridays only: the one Friday of the stay.
  await expect(
    card("Sunset dinner").getByRole("button", { name: /^Sunset dinner on / }),
  ).toHaveText(["Fri6 Nov"]);
  const priced = page.waitForRequest(
    (request) =>
      request.url().endsWith("/bookings/quote") &&
      request.postDataJSON()?.selection?.addons?.length === 4,
  );
  await card("Sunset dinner").getByRole("button", { name: "Sunset dinner on Fri 6 Nov" }).click();
  // Only the guest's own pick is sent; the server dates the rest.
  expect(
    (await priced)
      .postDataJSON()
      .selection.addons.map((addon: { id: string; dates: unknown }) => [addon.id, addon.dates])
      .sort(([a]: [string], [b]: [string]) => a.localeCompare(b)),
  ).toEqual([
    [id(1), null],
    [id(2), ["2026-11-06"]],
    [id(3), null],
    [id(4), null],
  ]);
  await expect(next).toHaveText("Continue to your details");
  await expect(next).toBeInViewport();
  const stay = page.getByRole("complementary", { name: "Your stay" });
  for (const line of [
    "Airport transfer€30",
    "Sunset dinner€90",
    "Welcome bottle€35",
    "Drop-off€25",
  ])
    await expect(stay).toContainText(line);
  await page.screenshot({ path: testInfo.outputPath("extras-six-1080p.png") });
});

test("skips Extras for a hotel without extras", async ({ page }) => {
  await mockFlow(page, { extras: false });
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=details/);
  // Visible only: "Your stay" has a phones-only "Details" button.
  const steps = page
    .locator("main")
    .getByText(/^(Rooms|Extras|Details|Review & pay)$/)
    .filter({ visible: true });
  await expect(steps).toHaveText(["Rooms", "Details", "Review & pay"]);
  await page.getByRole("button", { name: "Back to rooms" }).click();
  await expect(page).toHaveURL(/\/\?checkIn=2026-11-06&checkOut=2026-11-08&adults=2$/);
});

test("opens the first step a deep link can't skip", async ({ page }) => {
  await mockFlow(page);
  await page.goto(`${STAY}&step=payment`);
  // No details yet: the guest lands on the details step.
  await expect(page).toHaveURL(/[?&]step=details/);
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
});

test("a selection we can't price stops at Extras, above the buttons", async ({ page }) => {
  const { prices } = await mockFlow(page);
  prices.refuse = true;
  await page.goto(STAY);
  await expect(page).toHaveURL(/[?&]step=extras/);
  const notice = page.getByRole("alert").filter({ hasText: "We couldn't price this selection" });
  const next = page.getByRole("button", { name: "Continue without extras" });
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
  // With an extra added, Continue goes on to the details (VAY-2391).
  await expect(page.getByRole("button", { name: "Continue to your details" })).toBeEnabled();
});

test("a refused updated price keeps the stay on the payment step", async ({ page }) => {
  const { prices } = await mockFlow(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Continue without extras" }).click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
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
    page.getByRole("complementary", { name: "Your stay" }).getByText("Price no longer held"),
  ).toBeVisible();
});

test("a price that failed to load can be tried again", async ({ page }) => {
  const { prices } = await mockFlow(page);
  Object.assign(prices, { refuse: true, status: 503 });
  await page.goto(STAY);
  const notice = page.getByRole("alert").filter({ hasText: "We couldn't price this selection" });
  await expect(notice).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue without extras" })).toBeDisabled();
  prices.refuse = false;
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€268");
  await expect(page.getByRole("button", { name: "Continue without extras" })).toBeEnabled();
});

test("a way to pay the new choices don't take goes back to the hotel's own", async ({ page }) => {
  const { prices } = await mockFlow(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Continue without extras" }).click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await paymentOption(page, "card").click();
  await expect(orderTotal(page)).toHaveText("€268");
  // Back at Extras, the new choice can't be paid by card: it is priced to pay at the hotel.
  prices.refuse = "card";
  await page.getByRole("button", { name: "Back to details" }).click();
  await page.getByRole("button", { name: "Back to extras" }).click();
  await page
    .getByRole("region", { name: "Optional extras" })
    .getByRole("button", { name: "Add Garden breakfast" })
    .click();
  await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€340");
  await page.getByRole("button", { name: "Continue to your details" }).click();
  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(paymentOption(page, "pay_at_property")).toHaveAttribute("aria-checked", "true");
});

// VAY-2309: the first price used to pay at the hotel before the guest picked a way, so a rate
// paid by card was refused once ("Quote unavailable.", 404 in the console) before card worked.
// Payment now offers only the ways the chosen rates take.
for (const width of [1440, 390]) {
  test(`prices a rate paid by card with card first and offers only card at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [/\/change-request/],
    });
    await page.setViewportSize(
      width === 390 ? { width: 390, height: 844 } : { width, height: 900 },
    );
    const { prices } = await mockFlow(page, { offerPaymentMethods: ["card"] });
    // As the API does for a non-refundable rate paid by card.
    prices.refuse = "pay_at_property";
    await page.goto(STAY);
    await expect(page.getByRole("status", { name: "Your stay total" })).toContainText("€268");
    await page.getByRole("button", { name: "Continue without extras" }).click();
    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(paymentOption(page, "card")).toHaveAttribute("aria-checked", "true");
    await expect(orderTotal(page)).toHaveText("€268");
    await page.screenshot({
      path: testInfo.outputPath(`payment-card-rate-${width}.png`),
      fullPage: true,
    });
    await expect(paymentOption(page, "pay_at_property")).toHaveCount(0);
    expect(prices.asked.length).toBeGreaterThan(0);
    expect(prices.asked).not.toContain("pay_at_property");
    await assertHealthy();
  });
}

test("names a way to pay the rate doesn't take on Payment, in the guest's language", async ({
  page,
}) => {
  // An older API names no ways to pay, so the page offers both and the API refuses one.
  const { prices } = await mockFlow(page);
  await page.goto(STAY);
  await page.getByRole("button", { name: "Continue without extras" }).click();
  await fillGuestDetails(page);
  await page.getByRole("button", { name: "Continue to review" }).click();
  await paymentOption(page, "card").click();
  await expect(orderTotal(page)).toHaveText("€268");
  Object.assign(prices, { refuse: "pay_at_property", code: "PAYMENT_METHOD_NOT_ACCEPTED" });
  await paymentOption(page, "pay_at_property").click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "The rate you chose can't be paid this way. Please choose another way to pay.",
    }),
  ).toBeVisible();
  Object.assign(prices, { refuse: "pay_at_property", code: "PAYMENT_METHOD_NOT_ACCEPTED" });
  await page.goto(`/de${STAY}&step=payment`);
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Der gewählte Tarif kann nicht auf diese Weise bezahlt werden. Bitte wählen Sie eine andere Zahlungsart.",
    }),
  ).toBeVisible();
});

test("asks for another way to pay only where the guest can pick one", async ({ page }) => {
  // A hotel that takes only pay at the hotel, from an API that doesn't name the rate's ways:
  // another room is the way out.
  const { prices } = await mockFlow(page, { methods: ["pay_at_property"] });
  Object.assign(prices, { refuse: "pay_at_property", code: "PAYMENT_METHOD_NOT_ACCEPTED" });
  await page.goto(STAY);
  const notice = page.getByRole("alert").filter({ hasText: "We couldn't price this selection" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Choose another room" })).toBeVisible();
  await expect(page.getByText("Please choose another way to pay.")).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`says so when no way to pay is left for the chosen rate at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(
      width === 390 ? { width: 390, height: 844 } : { width, height: 900 },
    );
    const { prices, catalog } = await mockFlow(page, { offerPaymentMethods: ["card"] });
    const noWay = page.getByRole("alert").filter({
      hasText:
        "The rooms you chose can't be paid for in any way this hotel offers. Please choose other rooms.",
    });
    await page.goto(STAY);
    await page.getByRole("button", { name: "Continue without extras" }).click();
    await fillGuestDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    await expect(paymentOption(page, "card")).toHaveAttribute("aria-checked", "true");
    // Meanwhile the rate takes only a way this page doesn't offer: Payment says so instead of
    // showing no way to pay, and asks for no price.
    catalog.paymentMethods = ["paypal"];
    const asked = prices.asked.length;
    await page.reload();
    // The analytics question opens on every load until it's answered.
    await page.getByRole("button", { name: "Reject analytics" }).click();
    const ways = page.getByRole("region", { name: "How would you like to pay?" });
    await expect(ways.getByRole("alert")).toContainText(
      "The rooms you chose can't be paid for in any way this hotel offers.",
    );
    await expect(page.getByRole("radiogroup", { name: "Payment preference" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm booking" })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`payment-no-way-${width}.png`),
      fullPage: true,
    });
    // Past the 400 ms the page waits before asking for a price.
    await page.waitForTimeout(1_000);
    expect(prices.asked.length).toBe(asked);
    // The earlier steps say the same, with the way back to the rooms.
    await page.goto(STAY);
    await expect(noWay).toBeVisible();
    await expect(noWay.getByRole("button", { name: "Choose another room" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue without extras" })).toBeDisabled();
    await page.waitForTimeout(1_000);
    expect(prices.asked.length).toBe(asked);
    // In the guest's language.
    await page.goto(`/de${STAY}`);
    await expect(
      page.getByRole("alert").filter({
        hasText: "Für die gewählten Zimmer bietet diese Unterkunft keine passende Zahlungsart an.",
      }),
    ).toBeVisible();
  });
}

// VAY-2348 (D8): the hotel takes the rate's way to pay, just not for this arrival.
for (const [why, rules] of [
  // Bank transfer's 48-hour deadline: this hotel takes it from 20 Nov; the stay starts 6 Nov.
  ["payment deadline", { earliestArrival: { bank_transfer: "2026-11-20" } }],
  // The hotel's booking window: bank transfer only for guests booking at least 30 days ahead.
  ["booking window", { arrivalWindows: { bank_transfer: { from: "2026-11-20" } } }],
] as const) {
  test(`says online booking isn't available for these dates (${why})`, async ({ page }) => {
    // The rate takes only bank transfer.
    const { prices } = await mockFlow(page, {
      methods: ["pay_at_property", "bank_transfer"],
      offerPaymentMethods: ["bank_transfer"],
      ...rules,
    });
    await page.goto(STAY);
    const notice = page.getByRole("alert").filter({
      hasText: "Online booking isn't available for these dates. Please contact the hotel.",
    });
    await expect(notice).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(prices.asked).toEqual([]);
  });
}

test("says on the room form when no way to pay fits the chosen room", async ({ page }) => {
  const { prices } = await mockFlow(page, {
    methods: ["pay_at_property"],
    offerPaymentMethods: ["card"],
  });
  await page.goto("/book?checkIn=2026-11-06&checkOut=2026-11-08");
  await page.getByRole("button", { name: "Add room", exact: true }).click();
  const room = page.getByRole("group", { name: "Room 1", exact: true });
  await room.getByLabel("Room and meal option").selectOption(offerKey);
  await room.getByLabel(/Adults/).fill("2");
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "The rooms you chose can't be paid for in any way this hotel offers. Please choose other rooms.",
    }),
  ).toBeVisible();
  expect(prices.asked).toEqual([]);
});
