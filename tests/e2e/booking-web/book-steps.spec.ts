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

async function mockFlow(page: Page, { extras = true } = {}) {
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
              },
            ]
          : [],
      },
    }),
  );
  const quotes = new Map<string, { issuedAt: string; expiresAt: string }>();
  const unit: Record<string, number> = { [breakfast]: 1800, [lateCheckOut]: 3000 };
  await page.route("**/bookings/quote", (route) => {
    const { selection, paymentMethod } = route.request().postDataJSON();
    const quoteId = `55555555-5555-4555-8555-${String(quotes.size + 1).padStart(12, "0")}`;
    const times = {
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
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
  return { accepted };
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
    await expect(confirm).toBeDisabled();
    await page.getByLabel("I have read the room and rate terms for this price").check();
    await page.getByLabel("guest rules for this price").check();
    await page.screenshot({ path: testInfo.outputPath(`payment-${width}.png`), fullPage: true });
    // Another way to pay is a new price: its terms are ticked afresh.
    await paymentOption(page, "card").click();
    await expect(page.getByRole("button", { name: "Continue to card payment" })).toBeDisabled();
    await paymentOption(page, "pay_at_property").click();
    await page.getByLabel("I have read the room and rate terms for this price").check();
    await page.getByLabel("guest rules for this price").check();
    await confirm.click();

    await expect(page).toHaveURL(new RegExp(`/booking/${reference}$`));
    await expect(page.getByText(reference)).toBeVisible();
    // The choice keeps the name the steps showed (VAY-2190 plain names).
    await expect(page.getByText("Deluxe Double Room · Room only")).toBeVisible();
    await expect(page.getByText("Total Due", { exact: true }).locator("..")).toContainText("€370");
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
