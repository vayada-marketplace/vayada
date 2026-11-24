import { describe, expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms";
import type { FreeWindow } from "./agencyStayPrices.js";
import {
  createLiveStaySearch,
  parseLiveStaySearch,
  roomRefusal,
  type LiveStaySearch,
  type LiveStaySearchSources,
  type Refusal,
  type SearchOffers,
} from "./liveStaySearch.js";
import { fewestRooms, oneRoomFits, type StayPricesQuery } from "./publicPricingStayPrices.js";

const PROPERTY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOUBLE = "11111111-1111-4111-8111-111111111111";
const FAMILY = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-12-01T10:00:00Z");

const offers = (): SearchOffers => ({
  rooms: [
    {
      roomTypeId: DOUBLE,
      name: "Double",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
      offers: [
        {
          publicOfferKey: "double-flex",
          currency: "EUR",
          mealPlan: "breakfast",
          cancellation: { kind: "free_until_days_before_arrival", days: 3 },
          paymentMethods: ["pay_at_property"],
          paymentSchedule: { kind: "full" },
        },
        {
          publicOfferKey: "double-nonref",
          currency: "EUR",
          mealPlan: "room_only",
          cancellation: { kind: "non_refundable" },
          paymentMethods: ["card"],
          paymentSchedule: { kind: "full" },
        },
      ],
    },
    {
      roomTypeId: FAMILY,
      name: "Family",
      occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 2 },
      offers: [
        {
          publicOfferKey: "family-flex",
          currency: "EUR",
          mealPlan: "room_only",
          cancellation: { kind: "free_until_days_before_arrival", days: 14 },
          paymentMethods: ["card", "pay_at_property"],
          paymentSchedule: { kind: "full" },
        },
      ],
    },
  ],
});

/** Nightly prices per rate; a child with a known age adds 2,000 a night. */
const NIGHTLY: Record<string, number> = {
  "double-flex": 10_000,
  "double-nonref": 9_000,
  "family-flex": 15_000,
};

const nightsBetween = (checkIn: string, checkOut: string) =>
  Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
const day = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * A hotel as the booking page's stay prices see it, sized and priced one room at a time like the
 * real reader (`readOffered` with `room`): `free` says how many rooms of a type are free on every
 * night of a stay; `refuse` makes a free room's rates refuse a stay (a minimum stay, say).
 */
function hotel(
  options: {
    free?: (roomTypeId: string, checkIn: string, checkOut: string) => number;
    refuse?: (roomTypeId: string, checkIn: string, checkOut: string) => boolean;
    windows?: FreeWindow[];
    refusals?: Map<string, Refusal>;
    place?: { slug: string; timezone: string | null; childrenAccepted: boolean } | null;
    offered?: SearchOffers | null;
  } = {},
) {
  const free = options.free ?? (() => 2);
  const refuse = options.refuse ?? (() => false);
  const stayPrices = vi.fn(async (_slug: string, query: StayPricesQuery, offered: SearchOffers) => {
    const room = query.room!;
    const left = (roomTypeId: string) => free(roomTypeId, query.checkIn, query.checkOut);
    const nights = nightsBetween(query.checkIn, query.checkOut);
    const ages = room.childAges ?? [];
    return {
      version: "public-pricing-stay-prices.v1" as const,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      childrenPriced: ages.length === room.children,
      suggestedRooms: fewestRooms(
        offered.rooms.filter((one) => left(one.roomTypeId) >= 1),
        query,
      ),
      rooms: offered.rooms.map((one) => {
        const roomCount = oneRoomFits(one.occupancy, room) ? 1 : null;
        const available = roomCount !== null && left(one.roomTypeId) >= 1;
        return {
          roomTypeId: one.roomTypeId,
          roomCount,
          availability: available ? ("available" as const) : ("sold_out" as const),
          roomsLeft: available && left(one.roomTypeId) <= 3 ? left(one.roomTypeId) : null,
          roomsFree: Math.min(left(one.roomTypeId), 9),
          offers: one.offers.map((offer) =>
            available && !refuse(one.roomTypeId, query.checkIn, query.checkOut)
              ? {
                  publicOfferKey: offer.publicOfferKey,
                  status: "priced" as const,
                  totalMinor: String(
                    (NIGHTLY[offer.publicOfferKey]! + 2_000 * ages.length) * nights,
                  ),
                  currency: "EUR",
                  promoApplied: false,
                }
              : { publicOfferKey: offer.publicOfferKey, status: "unavailable" as const },
          ),
        };
      }),
    };
  });
  const sources = {
    property: vi.fn(async () =>
      options.place === undefined
        ? { slug: "villa-test", timezone: "Etc/UTC", childrenAccepted: true }
        : options.place,
    ),
    offers: vi.fn(async () => (options.offered === undefined ? offers() : options.offered)),
    stayPrices,
    freeWindows: vi.fn<LiveStaySearchSources["freeWindows"]>(async () => options.windows ?? []),
    refusals: vi.fn<LiveStaySearchSources["refusals"]>(
      async () => options.refusals ?? new Map<string, Refusal>(),
    ),
    now: () => NOW,
  } satisfies LiveStaySearchSources;
  return { sources, search: createLiveStaySearch(sources).search };
}

const stay = (patch: Partial<LiveStaySearch> = {}): LiveStaySearch => ({
  propertyId: PROPERTY,
  stay: { checkIn: "2026-12-10", checkOut: "2026-12-12" },
  adults: 2,
  childAges: [],
  ...patch,
});

describe("live stay search (VAY-2533)", () => {
  it("prices every room that fits, with each rate's total, rooms left and free cancellation", async () => {
    const { search, sources } = hotel({ free: (room) => (room === DOUBLE ? 2 : 5) });
    const result = await search(stay({ budgetMinor: "19000" }));
    expect(result).toMatchObject({
      version: "live-stay-search.v1",
      status: "available",
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
      nights: 2,
      childrenPriced: true,
      split: null,
      nearestFree: null,
    });
    expect(result.rooms).toEqual([
      {
        roomTypeId: DOUBLE,
        name: "Double",
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        status: "available",
        minNights: null,
        roomsLeft: 2,
        rates: [
          {
            publicOfferKey: "double-flex",
            mealPlan: "breakfast",
            cancellation: { kind: "free_until_days_before_arrival", days: 3 },
            freeCancellationUntil: "2026-12-07",
            paymentMethods: ["pay_at_property"],
            totalMinor: "20000",
            nightlyMinor: "10000",
            currency: "EUR",
            withinBudget: false,
          },
          {
            publicOfferKey: "double-nonref",
            mealPlan: "room_only",
            cancellation: { kind: "non_refundable" },
            freeCancellationUntil: null,
            paymentMethods: ["card"],
            totalMinor: "18000",
            nightlyMinor: "9000",
            currency: "EUR",
            withinBudget: true,
          },
        ],
      },
      expect.objectContaining({ roomTypeId: FAMILY, status: "available", roomsLeft: null }),
    ]);
    // One read for the whole party in one room, through the booking page's own prices; no
    // reasons or later dates are needed.
    expect(sources.stayPrices).toHaveBeenCalledTimes(1);
    expect(sources.stayPrices.mock.calls[0]![1]).toEqual({
      checkIn: "2026-12-10",
      checkOut: "2026-12-12",
      adults: 2,
      children: 0,
      promoCode: null,
      room: { adults: 2, children: 0, childAges: [] },
    });
    expect(sources.refusals).not.toHaveBeenCalled();
    expect(sources.freeWindows).not.toHaveBeenCalled();
  });

  it("says a free cancellation has passed once its last day is behind the hotel's today", async () => {
    const { search } = hotel();
    const result = await search(stay({ stay: { checkIn: "2026-12-03", checkOut: "2026-12-04" } }));
    const rates = result.rooms.flatMap((room) => room.rates);
    expect(rates.map((rate) => [rate.publicOfferKey, rate.freeCancellationUntil])).toEqual([
      ["double-flex", null],
      ["double-nonref", null],
      ["family-flex", null],
    ]);
  });

  it("prices children by their ages, and leaves them unpriced while an age is unknown", async () => {
    const { search, sources } = hotel();
    const priced = await search(stay({ childAges: [8] }));
    expect(priced.childrenPriced).toBe(true);
    // The double takes no children; the family room prices the child (2,000 a night).
    expect(priced.rooms.map((room) => [room.roomTypeId, room.status])).toEqual([
      [DOUBLE, "too_small"],
      [FAMILY, "available"],
    ]);
    expect(priced.rooms[1]!.rates[0]!.totalMinor).toBe("34000");
    expect(sources.stayPrices.mock.calls[0]![1].room).toEqual({
      adults: 2,
      children: 1,
      childAges: [8],
    });

    const unknown = await search(stay({ childAges: [8, null] }));
    expect(unknown.childrenPriced).toBe(false);
    expect(unknown.rooms[1]!.rates[0]!.totalMinor).toBe("30000");
    expect(sources.stayPrices.mock.calls[1]![1].room).toEqual({ adults: 2, children: 2 });
  });

  it("offers the cheapest two rooms booked together when one is too small for the group", async () => {
    const { search, sources } = hotel();
    const result = await search(stay({ adults: 3 }));
    expect(result.status).toBe("available");
    expect(result.rooms.map((room) => room.status)).toEqual(["too_small", "too_small"]);
    // Two doubles with the card rate: the cheapest pair paid the same way.
    expect(result.split).toMatchObject({
      roomCount: 2,
      totalMinor: "36000",
      nightlyMinor: "18000",
      currency: "EUR",
      withinBudget: null,
    });
    expect(
      result.split!.rooms.map((room) => [room.roomTypeId, room.adults, room.rate.publicOfferKey]),
    ).toEqual([
      [DOUBLE, 2, "double-nonref"],
      [DOUBLE, 1, "double-nonref"],
    ]);
    // The whole party, then each kind of room of the pair.
    expect(sources.stayPrices.mock.calls.map(([, query]) => query.room)).toEqual([
      { adults: 3, children: 0, childAges: [] },
      { adults: 2, children: 0, childAges: [] },
      { adults: 1, children: 0, childAges: [] },
    ]);
  });

  it("keeps a group's rooms to rates paid the same way, and its children in their rooms", async () => {
    // One double left: the second room is the family room, which shares only "card" with the
    // double's card rate.
    const { search } = hotel({ free: () => 1 });
    const result = await search(stay({ adults: 3, childAges: [6] }));
    expect(result.split).toMatchObject({ roomCount: 2, totalMinor: "52000" });
    // The child goes with the room of fewer adults, as the booking page spreads a group.
    expect(
      result.split!.rooms.map((room) => [
        room.roomTypeId,
        room.adults,
        room.childAges,
        room.rate.publicOfferKey,
      ]),
    ).toEqual([
      [DOUBLE, 2, [], "double-nonref"],
      [FAMILY, 1, [6], "family-flex"],
    ]);
  });

  it("says a party no rooms can take doesn't fit, without looking for other dates", async () => {
    const { search, sources } = hotel();
    const result = await search(stay({ adults: 20 }));
    expect(result).toMatchObject({ status: "no_fit", split: null, nearestFree: null });
    expect(sources.freeWindows).not.toHaveBeenCalled();
  });

  it("names a minimum stay as the reason a free room can't be booked", async () => {
    const refusals = new Map<string, Refusal>([[DOUBLE, { status: "minimum_stay", minNights: 3 }]]);
    const { search, sources } = hotel({ refuse: (room) => room === DOUBLE, refusals });
    const result = await search(stay());
    expect(result.status).toBe("available");
    expect(result.rooms.map((room) => [room.status, room.minNights, room.rates.length])).toEqual([
      ["minimum_stay", 3, 0],
      ["available", null, 1],
    ]);
    // Asked only for the refused room, with the party's guests.
    expect(sources.refusals).toHaveBeenCalledWith(
      "villa-test",
      { checkIn: "2026-12-10", checkOut: "2026-12-12" },
      { adults: 2, childAges: [] },
      [expect.objectContaining({ roomTypeId: DOUBLE })],
    );
  });

  it("finds the nearest free dates of the same length when everything is sold out", async () => {
    const windows: FreeWindow[] = [
      {
        checkIn: "2026-12-11",
        checkOut: "2026-12-13",
        offers: [{ roomTypeId: DOUBLE, publicOfferKey: "double-flex" }],
      },
      {
        checkIn: "2026-12-14",
        checkOut: "2026-12-16",
        offers: [{ roomTypeId: DOUBLE, publicOfferKey: "double-nonref" }],
      },
    ];
    // Full until the 13th: the first likely window isn't free after all, the second is.
    const { search, sources } = hotel({
      free: (_room, checkIn) => (checkIn >= "2026-12-14" ? 1 : 0),
      windows,
    });
    const result = await search(stay());
    expect(result).toMatchObject({
      status: "unavailable",
      split: null,
      nearestFree: { checkIn: "2026-12-14", checkOut: "2026-12-16" },
    });
    expect(result.rooms.map((room) => room.status)).toEqual(["sold_out", "sold_out"]);
    expect(sources.freeWindows).toHaveBeenCalledWith(
      "villa-test",
      { checkIn: "2026-12-10", checkOut: "2026-12-12" },
      [{ adults: 2, children: 0 }],
      offers(),
    );
    // Each window is confirmed with only the rate that found it free.
    expect(
      sources.stayPrices.mock.calls
        .slice(1)
        .map(([, query, offered]) => [
          query.checkIn,
          offered.rooms.flatMap((room) => room.offers.map((offer) => offer.publicOfferKey)),
        ]),
    ).toEqual([
      ["2026-12-11", ["double-flex"]],
      ["2026-12-14", ["double-nonref"]],
    ]);
  });

  it("looks for later dates in the fewest rooms when no one room takes the group", async () => {
    const { search, sources } = hotel({ free: () => 0 });
    const result = await search(stay({ adults: 3 }));
    expect(result).toMatchObject({ status: "unavailable", split: null, nearestFree: null });
    expect(sources.freeWindows.mock.calls[0]![2]).toEqual([
      { adults: 2, children: 0 },
      { adults: 1, children: 0 },
    ]);
  });

  it("searches a month for its first arrival the party can book", async () => {
    const windows: FreeWindow[] = [
      {
        checkIn: "2026-12-05",
        checkOut: "2026-12-09",
        offers: [{ roomTypeId: DOUBLE, publicOfferKey: "double-flex" }],
      },
    ];
    const { search } = hotel({
      free: (_room, checkIn) => (checkIn >= "2026-12-05" ? 2 : 0),
      windows,
    });
    // December has started: from the hotel's today.
    const result = await search(stay({ stay: { month: "2026-12", nights: 4 } }));
    expect(result).toMatchObject({
      status: "available",
      month: "2026-12",
      checkIn: "2026-12-05",
      checkOut: "2026-12-09",
      nights: 4,
      nearestFree: null,
    });
    expect(result.rooms[0]!.rates[0]!.totalMinor).toBe("40000");
  });

  it("keeps a full month's first arrival, with the next free dates after it", async () => {
    const windows: FreeWindow[] = [
      {
        checkIn: "2027-02-02",
        checkOut: "2027-02-04",
        offers: [{ roomTypeId: DOUBLE, publicOfferKey: "double-flex" }],
      },
    ];
    const { search } = hotel({
      free: (_room, checkIn) => (checkIn >= "2027-02-02" ? 2 : 0),
      windows,
    });
    const result = await search(stay({ stay: { month: "2027-01", nights: 2 } }));
    expect(result).toMatchObject({
      status: "unavailable",
      month: "2027-01",
      checkIn: "2027-01-01",
      checkOut: "2027-01-03",
      nearestFree: { checkIn: "2027-02-02", checkOut: "2027-02-04" },
    });
  });

  it("searches only the named room", async () => {
    const { search } = hotel();
    const result = await search(stay({ roomTypeId: FAMILY }));
    expect(result.rooms.map((room) => room.roomTypeId)).toEqual([FAMILY]);
    expect(
      await search(stay({ roomTypeId: "33333333-3333-4333-8333-333333333333" })),
    ).toMatchObject({ status: "not_bookable", rooms: [] });
  });

  it("answers without prices for past dates, hotels without a live page and no children", async () => {
    const past = hotel();
    expect(
      await past.search(stay({ stay: { checkIn: "2026-11-30", checkOut: "2026-12-02" } })),
    ).toMatchObject({ status: "past", rooms: [] });
    expect(await past.search(stay({ stay: { month: "2026-11", nights: 2 } }))).toMatchObject({
      status: "past",
    });
    expect(past.sources.offers).not.toHaveBeenCalled();

    expect(await hotel({ place: null }).search(stay())).toMatchObject({ status: "not_bookable" });
    expect(await hotel({ offered: null }).search(stay())).toMatchObject({
      status: "not_bookable",
    });
    const adultsOnly = hotel({
      place: { slug: "villa-test", timezone: "Etc/UTC", childrenAccepted: false },
    });
    expect(await adultsOnly.search(stay({ childAges: [5] }))).toMatchObject({
      status: "no_fit",
      childrenAccepted: false,
    });
    expect(await adultsOnly.search(stay())).toMatchObject({
      status: "available",
      childrenAccepted: true,
    });
  });

  it("refuses searches out of range", async () => {
    const { search } = hotel();
    const bad: unknown[] = [
      null,
      { ...stay(), propertyId: "villa" },
      { ...stay(), adults: 0 },
      { ...stay(), adults: 1.5 },
      { ...stay(), childAges: [18] },
      { ...stay(), childAges: ["8"] },
      { ...stay(), roomTypeId: "double" },
      { ...stay(), budgetMinor: "19.50" },
      { ...stay(), stay: { checkIn: "2026-12-12", checkOut: "2026-12-12" } },
      { ...stay(), stay: { checkIn: "2026-02-30", checkOut: "2026-03-02" } },
      { ...stay(), stay: { checkIn: "2026-12-01", checkOut: "2027-01-01" } },
      { ...stay(), stay: { month: "2026-13", nights: 2 } },
      { ...stay(), stay: { month: "2026-12", nights: 31 } },
    ];
    for (const input of bad) {
      expect(parseLiveStaySearch(input), JSON.stringify(input)).toBeNull();
      await expect(search(input as LiveStaySearch)).rejects.toThrow(TypeError);
    }
    expect(parseLiveStaySearch(stay({ childAges: [0, null, 17], budgetMinor: "0" }))).toEqual(
      stay({ childAges: [0, null, 17], budgetMinor: "0", roomTypeId: null }),
    );
  });
});

describe("why a free room's rates refuse a stay (VAY-2533)", () => {
  const rules = {
    minArrivalNights: 1,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    stopSell: false,
  };
  const room = (patch: Partial<typeof rules> = {}): PricingConfiguration =>
    ({
      version: "pricing.v2",
      propertyId: PROPERTY,
      roomTypeId: DOUBLE,
      revision: 1,
      currency: "EUR",
      capacity: { total: 2, adults: 2, children: 0 },
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
      },
      offers: [
        {
          id: "flex",
          termsRevision: "terms-1",
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: {
            kind: "independent",
            calendar: {
              base: { mode: "flat", amountMinor: "10000" },
              months: [],
              seasons: [],
              weekdays: [],
              dates: [],
            },
          },
          restrictions: {
            kind: "own",
            rules,
            seasons: [],
            dates: [{ date: "2026-12-10", rules: { ...rules, ...patch } }],
          },
        },
      ],
    }) as unknown as PricingConfiguration;
  const dates = { checkIn: "2026-12-10", checkOut: "2026-12-12" };
  const couple = { adults: 2, childAges: [] };

  it("names the minimum stay from that arrival", () => {
    expect(roomRefusal(room({ minArrivalNights: 3 }), ["flex"], dates, couple)).toEqual({
      status: "minimum_stay",
      minNights: 3,
    });
  });
  it("calls other rules closed, and guests the prices don't take too small", () => {
    expect(
      roomRefusal(room({ minArrivalNights: 3, closedToArrival: true }), ["flex"], dates, couple),
    ).toEqual({ status: "closed" });
    expect(roomRefusal(room({ stopSell: true }), ["flex"], dates, couple)).toEqual({
      status: "closed",
    });
    expect(roomRefusal(room(), ["flex"], dates, { adults: 2, childAges: [5] })).toEqual({
      status: "too_small",
    });
    expect(roomRefusal(room(), [], dates, couple)).toEqual({ status: "closed" });
  });
});
