import { afterEach, expect, it, vi } from "vitest";
import { getStayPrices } from "./stayPrices";

const stay = { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: 2, children: 1 };
const body = {
  version: "public-pricing-stay-prices.v1",
  checkIn: "2026-11-06",
  checkOut: "2026-11-08",
  rooms: [
    {
      roomTypeId: "suite",
      roomCount: 1,
      availability: "available",
      roomsLeft: 2,
      offers: [
        {
          publicOfferKey: "key-a",
          status: "priced",
          totalMinor: "29800",
          currency: "EUR",
          promoApplied: false,
        },
        { publicOfferKey: "key-b", status: "unavailable" },
        { publicOfferKey: "key-c", status: "unpriced" },
      ],
    },
    { roomTypeId: "loft", roomCount: null, availability: "sold_out", roomsLeft: null, offers: [] },
  ],
};
afterEach(() => vi.unstubAllGlobals());

it("reads the stay prices for the guests with a no-store request", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetcher);
  const { version: _version, ...prices } = body;
  expect(await getStayPrices("a/b", { ...stay, promoCode: "AUTUMN" })).toEqual(prices);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/booking-web/hotels/a%2Fb/pricing-offers/stay-prices?checkIn=2026-11-06&checkOut=2026-11-08&adults=2&children=1&promoCode=AUTUMN",
    { signal: undefined, cache: "no-store" },
  );
});

it("refuses prices for another stay or with malformed amounts", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const room = body.rooms[0];
  for (const bad of [
    { ...body, version: "old" },
    { ...body, checkOut: "2026-11-09" },
    { ...body, rooms: [{ ...room, availability: "maybe" }] },
    { ...body, rooms: [{ ...room, roomCount: 0 }] },
    { ...body, rooms: [{ ...room, roomsLeft: 0 }] },
    { ...body, rooms: [{ ...room, offers: [{ ...room.offers[0], totalMinor: "29.8" }] }] },
    { ...body, rooms: [{ ...room, offers: [{ ...room.offers[0], currency: "XXX" }] }] },
    { ...body, rooms: [{ ...room, offers: [{ ...room.offers[0], status: "cheap" }] }] },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(bad)));
    await expect(getStayPrices("hotel", stay)).rejects.toThrow("verified");
  }
});
