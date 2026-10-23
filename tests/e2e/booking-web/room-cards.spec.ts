import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, mockStayPrices } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";
import { mockAnyPrice } from "../support/bookFlow";

// VAY-2190: the booking page's room cards, restored from the old booking page on pricing v2.
const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const STAY = "/?checkIn=2026-11-06&checkOut=2026-11-08&adults=2";

async function mockRooms(page: Page, breakfastText?: string) {
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
                cancellation: { kind: "free_until_days_before_arrival", days: 3 },
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

    expect(new URL(stayRequests.at(-1)!).searchParams.toString()).toBe(
      "checkIn=2026-11-06&checkOut=2026-11-08&adults=2&children=0",
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

test("says only 'Not available' on a room whose one choice can't be booked (VAY-2319)", async ({
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
  await expect(garden.getByText("Last room available!")).toHaveCount(0);
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
