import type { Page } from "@playwright/test";

// VAY-2320: a group too big for one room chooses its rooms one by one, mixing room types.
/** A public offer key; its letter must be a hex digit, like the API's keys. */
export const key = (letter: string) => `pricing-offer.v2:${letter.repeat(64)}`;
// VAY-2393: a group starts in one room; `rooms=2` opens the room-by-room picker.
export const ONE_ROOM_STAY = "/?checkIn=2026-11-10&checkOut=2026-11-12&adults=3&children=1";
export const STAY = `${ONE_ROOM_STAY}&rooms=2`;
const deposit = { kind: "deposit", percent: 30, key: "deposit:3000:0:card" };
const free = (days: number) => ({ kind: "free_until_days_before_arrival", days });
const ROOMS = [
  {
    roomTypeId: "deluxe",
    name: "Deluxe Double Room",
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
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
      { key: "e", mealPlan: "breakfast", cancellation: free(5), price: "27800" },
      // Paid in full by card: can't join rooms paid with a deposit.
      {
        key: "b",
        mealPlan: "room_only",
        cancellation: { kind: "non_refundable" },
        price: "24800",
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

export async function mockGroup(page: Page, stayRequests: URL[], paymentMethods = ["card"]) {
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
            paymentMethods,
            paymentSchedule: "full" in offer ? { kind: "full" } : deposit,
          })),
        })),
      },
    }),
  );
  // Like the API: room by room, each type is sized for the room being chosen and bookable while
  // one room is free; a group no free room holds needs at least two rooms. Asked for the whole
  // party, a free room too small for it is priced for the adults it takes (VAY-2393).
  await page.route("**/pricing-offers/stay-prices**", (route) => {
    const url = new URL(route.request().url());
    stayRequests.push(url);
    const adults = Number(url.searchParams.get("roomAdults"));
    const children = Number(url.searchParams.get("roomChildren") ?? "0");
    const party = {
      adults: Number(url.searchParams.get("adults")),
      children: Number(url.searchParams.get("children") ?? "0"),
    };
    const holds = (room: (typeof ROOMS)[number], guests: typeof party) =>
      guests.adults >= 1 &&
      guests.adults <= room.occupancy.maxAdults &&
      guests.children <= room.occupancy.maxChildren &&
      guests.adults + guests.children <= room.occupancy.maxGuests;
    const wholeParty = adults === party.adults && children === party.children;
    const priced = (room: (typeof ROOMS)[number]) =>
      room.offers.map((offer) => ({
        publicOfferKey: key(offer.key),
        status: "priced",
        totalMinor: offer.price,
        currency: "EUR",
        promoApplied: false,
      }));
    return route.fulfill({
      json: {
        version: "public-pricing-stay-prices.v1",
        checkIn: url.searchParams.get("checkIn"),
        checkOut: url.searchParams.get("checkOut"),
        childrenPriced: children === 0,
        suggestedRooms: ROOMS.some((room) => room.free >= 1 && holds(room, party)) ? 1 : 2,
        rooms: ROOMS.map((room) => {
          const fits = holds(room, { adults, children });
          const available = fits && room.free >= 1;
          const partAdults = Math.min(
            room.occupancy.maxAdults,
            room.occupancy.maxGuests,
            party.adults - 1,
          );
          return {
            roomTypeId: room.roomTypeId,
            roomCount: fits ? 1 : null,
            availability: available ? "available" : "sold_out",
            roomsLeft: available && room.free <= 3 ? room.free : null,
            roomsFree: room.free,
            offers: available
              ? priced(room)
              : room.offers.map((offer) => ({
                  publicOfferKey: key(offer.key),
                  status: "unavailable",
                })),
            ...(wholeParty &&
              !fits &&
              room.free >= 1 &&
              partAdults >= 1 && { part: { adults: partAdults, offers: priced(room) } }),
          };
        }),
      },
    });
  });
}
