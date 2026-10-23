import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2320: a group too big for one room chooses its rooms one by one, mixing room types.
const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
const STAY = "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=3&children=1";
const deposit = { kind: "deposit", percent: 30, key: "deposit:3000:0:card" };
const free = (days: number) => ({ kind: "free_until_days_before_arrival", days });
const ROOMS = [
  {
    roomTypeId: "deluxe",
    name: "Deluxe Double Room",
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    free: 1,
    offers: [
      { key: "a", mealPlan: "room_only", cancellation: free(3), price: "29800" },
      { key: "c", mealPlan: "breakfast", cancellation: free(3), price: "33800" },
    ],
  },
  {
    roomTypeId: "garden",
    name: "Garden Double Room",
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
    free: 3,
    offers: [
      { key: "f", mealPlan: "room_only", cancellation: free(5), price: "23800" },
      { key: "g", mealPlan: "breakfast", cancellation: free(5), price: "27800" },
      // Paid in full by card: can't join rooms paid with a deposit.
      {
        key: "h",
        mealPlan: "room_only",
        cancellation: { kind: "non_refundable" },
        price: "21400",
        full: true,
      },
    ],
  },
  {
    roomTypeId: "family",
    name: "Family Room",
    occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 2 },
    free: 0,
    offers: [{ key: "d", mealPlan: "room_only", cancellation: free(3), price: "45800" }],
  },
];

async function mockGroup(page: Page, stayRequests: URL[]) {
  await page.clock.setFixedTime(new Date("2026-10-23T08:00:00Z"));
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({
      json: {
        version: "public-pricing-offers.v1",
        rooms: ROOMS.map((room) => ({
          roomTypeId: room.roomTypeId,
          name: room.name,
          occupancy: room.occupancy,
          offers: room.offers.map((offer) => ({
            publicOfferKey: key(offer.key),
            currency: "EUR",
            mealPlan: offer.mealPlan,
            cancellation: offer.cancellation,
            paymentMethods: ["card"],
            paymentSchedule: "full" in offer ? { kind: "full" } : deposit,
          })),
        })),
      },
    }),
  );
  // Like the API: room by room, each type is sized for the room being chosen and bookable while
  // one room is free; the whole group needs at least two rooms.
  await page.route("**/pricing-offers/stay-prices**", (route) => {
    const url = new URL(route.request().url());
    stayRequests.push(url);
    const adults = Number(url.searchParams.get("roomAdults"));
    const children = Number(url.searchParams.get("roomChildren") ?? "0");
    return route.fulfill({
      json: {
        version: "public-pricing-stay-prices.v1",
        checkIn: url.searchParams.get("checkIn"),
        checkOut: url.searchParams.get("checkOut"),
        childrenPriced: children === 0,
        suggestedRooms: 2,
        rooms: ROOMS.map((room) => {
          const fits =
            adults >= 1 &&
            adults <= room.occupancy.maxAdults &&
            children <= room.occupancy.maxChildren &&
            adults + children <= room.occupancy.maxGuests;
          const available = fits && room.free >= 1;
          return {
            roomTypeId: room.roomTypeId,
            roomCount: fits ? 1 : null,
            availability: available ? "available" : "sold_out",
            roomsLeft: available && room.free <= 3 ? room.free : null,
            roomsFree: room.free,
            offers: room.offers.map((offer) =>
              available
                ? {
                    publicOfferKey: key(offer.key),
                    status: "priced",
                    totalMinor: offer.price,
                    currency: "EUR",
                    promoApplied: false,
                  }
                : { publicOfferKey: key(offer.key), status: "unavailable" },
            ),
          };
        }),
      },
    });
  });
}

for (const width of [1440, 390]) {
  test(`lets a group choose a different room type for each room at ${width}px`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    if (width === 390) await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);
    const stayRequests: URL[] = [];
    await mockGroup(page, stayRequests);
    await page.goto(STAY);

    const bar = page.getByTestId(width === 390 ? "rooms-bar-mobile" : "rooms-bar");
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "Continue" })).toBeDisabled();
    await expect(page.getByText("2 rooms", { exact: true })).toBeVisible();

    // Room 1 (2 adults): every type with a free room that fits them can be chosen.
    const deluxe = page.getByTestId("room-card-deluxe");
    await expect(deluxe).toContainText("Select your rate for room 1 · 2 Adults");
    await deluxe.getByRole("button", { name: "Choose for room 1" }).click();

    // Room 2 (1 adult, 1 child): the last Deluxe is in room 1, which takes a deposit.
    await expect(deluxe.getByRole("button", { name: "None left for room 2" })).toBeDisabled();
    await expect(deluxe).toContainText("In your room 1");
    await expect(deluxe).toContainText("You chose the last one for room 1.");
    const garden = page.getByTestId("room-card-garden");
    await expect(garden).toContainText("Select your rate for room 2 · 1 Adult, 1 Child");
    const fullPayment = garden.locator(`[data-offer-key="${key("h")}"]`);
    await expect(fullPayment).toBeDisabled();
    await expect(fullPayment).toContainText("Can't combine");
    await expect(fullPayment).toContainText("One booking is paid one way.");
    await expect(page.getByTestId("room-card-family")).toContainText("Sold Out");
    await garden.getByRole("button", { name: "Choose for room 2" }).click();

    // Both rooms chosen: their total, and /book gets each room's rate and guests.
    await expect(bar).toContainText("€536");
    if (width === 1440) {
      await expect(bar).toContainText("Deluxe Double Room");
      await expect(bar).toContainText("Garden Double Room");
    }
    await bar.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/(en\/)?book\?/);
    const params = new URL(page.url()).searchParams;
    expect(params.getAll("pick")).toEqual([`2-0-${key("a")}`, `1-1-${key("f")}`]);
    expect(params.get("rooms")).toBe("2");

    // The cards asked about room 1's guests, then room 2's.
    const asked = stayRequests.map((url) => [
      url.searchParams.get("roomAdults"),
      url.searchParams.get("roomChildren"),
    ]);
    expect(asked).toContainEqual(["2", "0"]);
    expect(asked).toContainEqual(["1", "1"]);
    await assertHealthy();
  });
}

test("lets the group change a chosen room and keeps its rooms on Back", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await page.goto(STAY);
  const bar = page.getByTestId("rooms-bar");
  await page
    .getByTestId("room-card-garden")
    .getByRole("button", { name: "Choose for room 1" })
    .click();
  await page
    .getByTestId("room-card-garden")
    .getByRole("button", { name: "Choose for room 2" })
    .click();
  await expect(bar).toContainText("€476");
  await bar.getByTestId("rooms-bar-slot-1").getByRole("button", { name: "Change" }).click();
  await expect(bar.getByTestId("rooms-bar-slot-1")).toContainText("Choose a room below");
  await page
    .getByTestId("room-card-deluxe")
    .getByRole("button", { name: "Choose for room 1" })
    .click();
  await expect(bar).toContainText("€536");
  await bar.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/(en\/)?book\?/);
  await page.goBack();
  await expect(page.getByTestId("rooms-bar")).toContainText("€536");
  await assertHealthy();
});

test("starts at the fewest rooms the group needs and lets it add rooms", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockBookingApis(page);
  await mockGroup(page, []);
  await page.goto(STAY);
  await expect(page.getByTestId("rooms-bar")).toBeVisible();
  await page.getByText("3 Adults, 1 Child", { exact: true }).click();
  const picker = page.getByTestId("guest-selector");
  await expect(picker.getByText("4 guests need at least 2 rooms here")).toBeVisible();
  await expect(picker.getByRole("button", { name: "Fewer Rooms" })).toBeDisabled();
  await picker.getByRole("button", { name: "More Rooms" }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("rooms-bar")).toContainText("Your 3 rooms");
  await expect(page.getByTestId("rooms-bar-slot-3")).toBeVisible();
  await assertHealthy();
});
