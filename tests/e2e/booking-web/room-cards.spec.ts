import { expect, test, type Page } from "@playwright/test";
import { BOOKING_WEB_ANALYTICS_CONSENT_VERSION as CONSENT } from "@vayada/domain-booking/conversion-funnel";
import { mockBookingApis, mockStayPrices, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { mockAnyPrice } from "../support/bookFlow";

// VAY-2190: the booking page's room cards, restored from the old booking page on pricing v2.
const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const STAY = "/?checkIn=2026-11-06&checkOut=2026-11-08&adults=2";

async function mockRooms(
  page: Page,
  breakfastText?: string,
  gardenCancellation: Record<string, unknown> = { kind: "non_refundable" },
  deluxeCancellation: Record<string, unknown> = {
    kind: "free_until_days_before_arrival",
    days: 3,
  },
) {
  // Free cancellation reads as a date that must not have passed yet.
  await page.clock.setFixedTime(new Date("2026-10-14T08:00:00Z"));
  await page.route("https://images.vayada.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PHOTO }),
  );
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "deluxe",
            name: "Deluxe Double Room",
            description: "Our quietest room, facing the garden.",
            occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
            images: [
              { url: "https://images.vayada.com/test/deluxe-1.png", alt: "Deluxe room" },
              { url: "https://images.vayada.com/test/deluxe-2.png", alt: "Deluxe bathroom" },
            ],
            size: { value: 32, unit: "sqm" },
            category: "Double",
            amenities: ["Free WiFi", "Rain shower", "Garden view", "Coffee machine", "Desk"],
            offers: [
              {
                publicOfferKey: key("a"),
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: deluxeCancellation,
              },
              {
                publicOfferKey: key("b"),
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: { kind: "non_refundable" },
              },
              {
                publicOfferKey: key("c"),
                currency: "EUR",
                mealPlan: "breakfast",
                cancellation: { kind: "free_until_days_before_arrival", days: 3 },
                ...(breakfastText && { mealDescription: breakfastText }),
              },
            ],
          },
          {
            roomTypeId: "family",
            name: "Family Room",
            occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 2 },
            images: [{ url: "https://images.vayada.com/test/family.png", alt: "Family room" }],
            offers: [{ publicOfferKey: key("d"), currency: "EUR", mealPlan: "room_only" }],
          },
          {
            roomTypeId: "garden",
            name: "Garden Suite",
            occupancy: { maxGuests: 3, maxAdults: 3, maxChildren: 1 },
            offers: [
              {
                publicOfferKey: key("e"),
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: gardenCancellation,
              },
            ],
          },
        ],
      },
    }),
  );
  await mockStayPrices(
    page,
    {
      deluxe: { [key("a")]: "29800", [key("b")]: "26800", [key("c")]: "33800" },
      family: { [key("d")]: "43800" },
      garden: { [key("e")]: "35800" },
    },
    { family: { availability: "sold_out" }, garden: { roomsLeft: 2 } },
  );
}

for (const width of [1440, 390]) {
  test(`shows rooms with their choices and opens /book with the picked one at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);
    await mockRooms(page);
    await mockAnyPrice(page);
    const stayRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/stay-prices")) stayRequests.push(request.url());
    });
    await page.goto(STAY);

    const deluxe = page.getByTestId("room-card-deluxe");
    await expect(deluxe.getByRole("heading", { name: "Deluxe Double Room" })).toBeVisible();
    await expect(deluxe.getByText("32m²")).toBeVisible();
    await expect(deluxe.getByText("Up to 2 guests")).toBeVisible();
    await expect(deluxe.getByText("+1 more")).toBeVisible();
    // Cheapest first and selected, as the old card did with non-refundable.
    const choices = deluxe.locator("[data-offer-key]");
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toContainText("Non-refundable");
    await expect(choices.nth(0)).toContainText("-10% OFF");
    // VAY-2389: rate names sit on 20px lines, 6px above the description, badge or not. The 18px
    // badge is centered on the name's line at 1440; at 390 it wraps and starts flush below it.
    const box = async (choice: number, p: number) =>
      (await choices.nth(choice).locator("p").nth(p).boundingBox())!;
    const badge = (await choices.nth(0).getByText("-10% OFF").boundingBox())!;
    const [title, terms] = [await box(0, 0), await box(0, 1)];
    const line = width === 390 ? title.y + 20 : title.y;
    expect(badge.height).toBe(18);
    expect(title.height).toBe(width === 390 ? 40 : 20);
    expect(badge.y).toBe(line + 1);
    if (width === 390) expect(badge.x).toBe(title.x);
    expect(terms.y - (title.y + title.height)).toBe(6);
    const [plainTitle, plainTerms] = [await box(1, 0), await box(1, 1)];
    expect(plainTitle.height).toBe(20);
    expect(plainTerms.y - (plainTitle.y + plainTitle.height)).toBe(6);
    await expect(choices.nth(0)).toContainText("€268");
    await expect(choices.nth(0)).toContainText("€134 / per night");
    await expect(choices.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(choices.nth(1)).toContainText("Free cancellation");
    await expect(choices.nth(1)).toContainText(/Free cancellation until 3 Nov/);
    await expect(choices.nth(2)).toContainText("Breakfast included");
    await expect(choices.nth(2)).toContainText("Breakfast every morning");

    const family = page.getByTestId("room-card-family");
    await expect(family.getByRole("button", { name: "Sold Out" }).last()).toBeDisabled();
    await expect(page.getByTestId("room-card-garden").getByText("Only 2 left")).toBeVisible();
    // A room without photos shows a quiet placeholder instead.
    await expect(page.getByTestId("room-card-garden").locator("img")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Choose rooms and get a price" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`room-cards-${width}.png`), fullPage: true });

    // VAY-2320: the cards are priced for one room with the whole party.
    expect(new URL(stayRequests.at(-1)!).searchParams.toString()).toBe(
      "checkIn=2026-11-06&checkOut=2026-11-08&adults=2&children=0&roomAdults=2&roomChildren=0",
    );
    await choices.nth(1).click();
    await expect(choices.nth(1)).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("select-rate-deluxe").click();
    await expect(page).toHaveURL(
      new RegExp(
        `/(en/)?book\\?checkIn=2026-11-06&checkOut=2026-11-08&adults=2&offer=${encodeURIComponent(key("a")).replace(/[.]/g, "\\.")}(&step=[a-z]+)?$`,
      ),
    );
    await assertHealthy();
  });
}

for (const width of [1440, 390]) {
  test(`leads with the guest display currency and says what the guest pays at ${width}px (VAY-2390)`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await page.addInitScript(
      ({ slug, version }) =>
        localStorage.setItem(
          `vayada_booking_analytics:${slug}`,
          JSON.stringify({ version, analytics: false }),
        ),
      { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
    );
    await mockBookingApis(page, { displayDefaultCurrency: "USD" });
    await mockRooms(page);
    await mockAnyPrice(page);
    await page.goto(STAY);

    const note = page.getByTestId("approximate-amounts-note");
    await expect(note).toContainText(
      "We charge in EUR. Amounts marked ≈ are approximate conversions.",
    );
    const choices = page.getByTestId("room-card-deluxe").locator("[data-offer-key]");
    // €268 at 1.1: what the guest sees first, then what they pay in its place of the night price.
    await expect(choices.nth(0)).toContainText("≈ US$295");
    await expect(choices.nth(0)).toContainText("You pay €268");
    await expect(choices.nth(0)).not.toContainText("per night");
    await page.screenshot({
      path: testInfo.outputPath(`room-cards-usd-${width}.png`),
      fullPage: true,
    });

    if (width === 1440) {
      // A guest who picks the hotel currency sees its plain prices, and keeps that choice.
      const nav = page.locator("nav");
      await nav.getByRole("button", { name: "USD", exact: true }).click();
      await nav.getByRole("button", { name: "€ Euro" }).click();
      await expect(choices.nth(0)).toContainText("€134 / per night");
      await expect(note).toHaveCount(0);
      await page.reload();
      await expect(nav.getByRole("button", { name: "EUR", exact: true })).toBeVisible();
      await expect(choices.nth(0)).toContainText("€268");
    }
    await assertHealthy();
  });
}

for (const width of [1440, 390]) {
  test(`names free cancellation non-refundable once its last day has passed at ${width}px (VAY-2392)`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await page.addInitScript(
      ({ slug, version }) =>
        localStorage.setItem(
          `vayada_booking_analytics:${slug}`,
          JSON.stringify({ version, analytics: false }),
        ),
      { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
    );
    await mockBookingApis(page);
    // The Garden Suite's one choice is free cancellation until 3 days before arrival.
    await mockRooms(page, undefined, { kind: "free_until_days_before_arrival", days: 3 });
    // 4 Nov: for a stay from 6 Nov, free cancellation ended with 3 Nov.
    await page.clock.setFixedTime(new Date("2026-11-04T08:00:00Z"));
    await page.goto(STAY);

    // Free cancellation now has the same terms as non-refundable at a higher price: only the
    // cheaper one shows, with its saving.
    const deluxe = page.getByTestId("room-card-deluxe").locator("[data-offer-key]");
    await expect(deluxe).toHaveCount(2);
    await expect(deluxe.nth(0)).toContainText("Non-refundable");
    await expect(deluxe.nth(0)).toContainText("-10% OFF");
    await expect(deluxe.nth(1)).toContainText("Breakfast included, non-refundable");
    await expect(deluxe.nth(1)).toContainText(
      "Free cancellation ends 3 days before arrival. For these dates, no refund if you cancel or don't arrive",
    );
    await expect(deluxe.nth(1)).not.toContainText("OFF");
    // A room whose one choice is free cancellation reads non-refundable, never "Room only".
    const garden = page.getByTestId("room-card-garden").locator("[data-offer-key]");
    await expect(garden).toHaveCount(1);
    await expect(garden).toContainText("Non-refundable");
    await expect(garden).toContainText("Free cancellation ends 3 days before arrival.");
    await expect(garden).not.toContainText("Room only");
    await expect(garden).not.toContainText("OFF");
    await page.screenshot({
      path: testInfo.outputPath(`room-cards-window-passed-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await assertHealthy();
  });

  test(`names a partial refund non-refundable once its last refund day has passed at ${width}px (VAY-2406)`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await page.addInitScript(
      ({ slug, version }) =>
        localStorage.setItem(
          `vayada_booking_analytics:${slug}`,
          JSON.stringify({ version, analytics: false }),
        ),
      { slug: SEEDED_BOOKING_SLUG, version: CONSENT },
    );
    await mockBookingApis(page);
    // Deluxe's room-only rate and the Garden Suite's one rate refund in part until 7 days before
    // arrival; Deluxe's breakfast rate is still free cancellation until 3 days before.
    const partial = { kind: "partial_refund", days: 7 };
    await mockRooms(page, undefined, partial, partial);
    // 1 Nov: for a stay from 6 Nov, refunds ended with 30 Oct; free cancellation runs to 3 Nov.
    await page.clock.setFixedTime(new Date("2026-11-01T08:00:00Z"));
    await page.goto(STAY);

    // The partial refund now has the same terms as non-refundable at a higher price: only the
    // cheaper one shows, with its saving.
    const deluxe = page.getByTestId("room-card-deluxe").locator("[data-offer-key]");
    await expect(deluxe).toHaveCount(2);
    await expect(deluxe.nth(0)).toContainText("Non-refundable");
    await expect(deluxe.nth(0)).toContainText("-10% OFF");
    await expect(deluxe.nth(1)).toContainText("Breakfast included");
    await expect(deluxe.nth(1)).toContainText("Free cancellation until 3 Nov");
    await expect(page.getByTestId("room-card-deluxe")).not.toContainText("Partial refund");
    // A room whose one choice is that partial refund reads non-refundable, with the reason.
    const garden = page.getByTestId("room-card-garden").locator("[data-offer-key]");
    await expect(garden).toHaveCount(1);
    await expect(garden).toContainText("Non-refundable");
    await expect(garden).toContainText(
      "Refunds end 7 days before arrival. For these dates, no refund if you cancel or don't arrive",
    );
    await expect(garden).not.toContainText("Partial refund");
    await expect(garden).not.toContainText("OFF");
    await page.screenshot({
      path: testInfo.outputPath(`room-cards-refunds-passed-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await assertHealthy();
  });
}

test("shows the hotel's own breakfast text on its choice (VAY-2281)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockRooms(page, "Buffet breakfast in the Stube, 7:00–10:30");
  await page.goto(STAY);
  const breakfast = page.getByTestId("room-card-deluxe").locator(`[data-offer-key="${key("c")}"]`);
  await expect(breakfast).toContainText("Breakfast included");
  await expect(breakfast).toContainText("Buffet breakfast in the Stube, 7:00–10:30");
  await expect(breakfast).not.toContainText("Breakfast every morning");
  await assertHealthy();
});

test("keeps the rooms choosable when prices can't be loaded", async ({ page }) => {
  await mockBookingApis(page);
  await mockRooms(page);
  await page.route("**/pricing-offers/stay-prices**", (route) =>
    route.fulfill({ status: 503, json: { detail: "Stay prices temporarily unavailable." } }),
  );
  await page.goto(STAY);

  await expect(
    page.getByRole("alert").filter({ hasText: "We couldn't load prices for these dates" }),
  ).toBeVisible();
  const deluxe = page.getByTestId("room-card-deluxe");
  await expect(deluxe.locator("[data-offer-key]")).toHaveCount(3);
  await page.getByTestId("select-rate-deluxe").click();
  await expect(page).toHaveURL(/\/(en\/)?book\?.*offer=/);
});

test("says why a room whose one choice can't be booked is not available (VAY-2319)", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockBookingApis(page);
  await mockRooms(page);
  // The last free room, but its only choice has no price for the stay.
  await mockStayPrices(
    page,
    {
      deluxe: { [key("a")]: "29800", [key("b")]: "26800", [key("c")]: "33800" },
      family: { [key("d")]: "43800" },
      garden: { [key("e")]: null },
    },
    { garden: { roomsLeft: 1 } },
  );
  await page.goto(STAY);

  const garden = page.getByTestId("room-card-garden");
  await expect(garden.locator(`[data-offer-key="${key("e")}"]`)).toContainText("Not available");
  await expect(page.getByTestId("select-rate-garden")).toBeDisabled();
  await expect(page.getByTestId("select-rate-garden")).toHaveText("Not available");
  await page.getByRole("button", { name: "Reject analytics" }).click();
  await garden.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("room-card-not-available-1440.png") });
  const reason = "This room can't be booked for these dates. Try other dates.";
  await expect(garden.getByText(reason)).toBeVisible();
  await expect(garden.getByText("Last room available!")).toHaveCount(0);
  // A sold-out room says "Sold Out" instead.
  await expect(page.getByTestId("room-card-family").getByText(reason)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await garden.getByText(reason).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("room-card-not-available-390.png") });
  // A bookable room keeps its rooms-left line.
  await mockStayPrices(
    page,
    {
      deluxe: { [key("a")]: "29800", [key("b")]: "26800", [key("c")]: "33800" },
      family: { [key("d")]: "43800" },
      garden: { [key("e")]: "35800" },
    },
    { garden: { roomsLeft: 1 } },
  );
  await page.reload();
  await expect(garden.getByText("Last room available!")).toBeVisible();
  await expect(garden.getByText(reason)).toHaveCount(0);
  await assertHealthy();
});

test("fills in /book from a room card, with plain option names", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockRooms(page);
  // A group of three in rooms for two: the card sends two rooms of its choice. With a child
  // whose age isn't known yet, /book opens at the room form (VAY-2195) to ask for it.
  await page.goto(
    `/book?checkIn=2026-11-06&checkOut=2026-11-08&adults=3&children=1&offer=${key("a")}&rooms=2`,
  );

  const first = page.getByRole("group", { name: "Room 1" });
  const second = page.getByRole("group", { name: "Room 2" });
  await expect(first.getByLabel("Room and meal option")).toHaveValue(key("a"));
  await expect(second.getByLabel("Room and meal option")).toHaveValue(key("a"));
  await expect(first.getByRole("spinbutton", { name: /Adults/ })).toHaveValue("2");
  await expect(second.getByRole("spinbutton", { name: /Adults/ })).toHaveValue("1");
  await expect(first.locator(`option[value="${key("a")}"]`)).toHaveText(
    "Deluxe Double Room — Free cancellation",
  );
  await expect(first.locator(`option[value="${key("c")}"]`)).toHaveText(
    "Deluxe Double Room — Breakfast included",
  );
  await expect(first.locator(`option[value="${key("e")}"]`)).toHaveText(
    "Garden Suite — Non-refundable",
  );
  await assertHealthy();
});

test("lets the guest choose again when the card's choice is no longer offered", async ({
  page,
}) => {
  await mockBookingApis(page);
  await mockRooms(page);
  await page.goto(`/book?checkIn=2026-11-06&checkOut=2026-11-08&adults=2&offer=${key("f")}`);
  const room = page.getByRole("group", { name: "Room 1" });
  await expect(room.locator(`option[value="${key("a")}"]`)).toHaveCount(1);
  await expect(room.getByLabel("Room and meal option")).toHaveValue("");
  await expect(page.getByRole("group", { name: "Room 2" })).toHaveCount(0);
});

test("shows a room's details with its choices, as the old page did", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockRooms(page);
  await page.goto(STAY);

  const deluxe = page.getByTestId("room-card-deluxe");
  await deluxe.getByRole("button", { name: "View Details" }).click();
  const dialog = page.getByRole("dialog", { name: "Deluxe Double Room" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Our quietest room, facing the garden.")).toBeVisible();
  await expect(dialog.getByText("Desk")).toBeVisible();
  await expect(dialog.locator("[data-offer-key]")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("room-details.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await deluxe.getByRole("button", { name: "View Details" }).click();
  await dialog.locator(`[data-offer-key="${key("c")}"]`).click();
  await dialog.getByRole("button", { name: "Select This Rate" }).click();
  await expect(page).toHaveURL(new RegExp(`/(en/)?book\\?.*offer=${encodeURIComponent(key("c"))}`));
  await assertHealthy();
});

test("VAY-2410: shows a room's details wide, with a 5:4 photo and the rates pinned beside it", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 1920, height: 960 });
  await mockBookingApis(page);
  await page.clock.setFixedTime(new Date("2026-10-14T08:00:00Z"));
  await page.route("https://images.vayada.com/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PHOTO }),
  );
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: [
          {
            roomTypeId: "villa",
            name: "Garden House",
            description:
              "A restored merchant's house in the old town with a quiet courtyard pool, four bright " +
              "bedrooms and an en-suite shower room for each of them. Step out into lanes full of " +
              "cafés, small shops and museums, or walk two minutes from the back gate to the beach. " +
              "The kitchen is fully equipped, the living room opens onto the courtyard, and the roof " +
              "terrace looks over the town walls at sunset. Daily housekeeping is included.",
            occupancy: { maxGuests: 8, maxAdults: 8, maxChildren: 4 },
            images: ["courtyard", "bedroom", "pool"].map((name) => ({
              url: `https://images.vayada.com/test/${name}.png`,
              alt: name,
            })),
            size: { value: 79, unit: "sqm" },
            category: "Villa",
            bedrooms: 4,
            bathrooms: 3,
            amenities: Array.from({ length: 18 }, (_, index) => `Amenity ${index + 1}`),
            offers: [
              {
                publicOfferKey: key("7"),
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: { kind: "free_until_days_before_arrival", days: 3 },
              },
              {
                publicOfferKey: key("8"),
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: { kind: "non_refundable" },
              },
            ],
          },
        ],
      },
    }),
  );
  await mockStayPrices(
    page,
    { villa: { [key("7")]: "20000", [key("8")]: "18000" } },
    { villa: { roomsLeft: 1 } },
  );
  await page.goto(STAY);
  await page.getByTestId("room-card-villa").getByRole("button", { name: "View Details" }).click();

  const dialog = page.getByRole("dialog", { name: "Garden House" });
  const photo = dialog.getByRole("img", { name: "courtyard" });
  const cta = dialog.getByRole("button", { name: "Select This Rate · €180" });
  await expect(dialog.getByText("79 m² · Up to 8 guests · 4 bedrooms · 3 bathrooms")).toBeVisible();
  await expect(dialog.getByText("6 Nov – 8 Nov · 2 nights")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show all 18 amenities" })).toBeVisible();
  await expect(dialog.getByText("Amenity 9", { exact: true })).toHaveCount(0);
  // Up to 1360px wide; the 5:4 photo is 3/5 of it and sets the window's height.
  const box = (await dialog.boundingBox())!;
  const shot = (await photo.boundingBox())!;
  expect(box.width).toBe(1360);
  expect(Math.abs(shot.width - 816)).toBeLessThan(1);
  expect(Math.abs(shot.width / shot.height - 1.25)).toBeLessThan(0.01);
  expect(Math.abs(shot.height - box.height)).toBeLessThan(2);
  // The rates and their button stay in view while the details beside them get longer.
  await expect(cta).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText("Last room available!")).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("button", { name: "Read more" }).click();
  await expect(dialog.getByRole("button", { name: "Show less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(cta).toBeInViewport({ ratio: 1 });
  // Keyboard focus below the fold scrolls clear of the pinned rates, not behind them.
  const showAll = dialog.getByRole("button", { name: "Show all 18 amenities" });
  await showAll.focus();
  await expect
    .poll(() =>
      showAll.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return element.contains(hit);
      }),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("room-details-1920.png") });

  // A short wide window leaves too little room above the rates: they scroll with the details.
  await page.setViewportSize({ width: 1024, height: 700 });
  await dialog.getByRole("heading", { name: "Garden House" }).scrollIntoViewIfNeeded();
  await expect(cta).not.toBeInViewport();
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toBeInViewport({ ratio: 1 });

  // Under 1024px, one column: the details and rates follow the photo in one scroll.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(async () => (await dialog.boundingBox())?.width).toBe(672);
  await expect(cta).not.toBeInViewport();
  // Phones keep the full-screen window with its 288px photo.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => dialog.boundingBox())
    .toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect((await photo.boundingBox())?.height).toBe(288);

  await cta.click();
  await expect(page).toHaveURL(new RegExp(`/(en/)?book\\?.*offer=${encodeURIComponent(key("8"))}`));
  await assertHealthy();
});
