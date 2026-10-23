import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const authority = vi.hoisted(() => vi.fn());
const totals = vi.hoisted(() => vi.fn());
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: authority }));
vi.mock("./publicPricingChargeTotals.js", () => ({ lockPublicPricingChargeTotals: totals }));

import {
  createPublicPricingStayPrices,
  fewestRooms,
  oneRoomFits,
  parseStayPricesQuery,
  roomsForParty,
  splitAdults,
} from "./publicPricingStayPrices.js";

const ROOM_A = "11111111-1111-4111-8111-111111111111";
const ROOM_B = "22222222-2222-4222-8222-222222222222";
const stay = {
  checkIn: "2026-11-06",
  checkOut: "2026-11-08",
  adults: 2,
  children: 0,
  promoCode: null,
};
type Offer = { publicOfferKey: string; currency: string };
const defaultRooms = () => [
  {
    roomTypeId: ROOM_A,
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    offers: [
      { publicOfferKey: "offer-a-free", currency: "EUR" },
      { publicOfferKey: "offer-a-nonref", currency: "EUR" },
    ] as Offer[],
  },
  {
    roomTypeId: ROOM_B,
    occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 2 },
    offers: [{ publicOfferKey: "offer-b", currency: "EUR" }] as Offer[],
  },
];

function setup(
  inventory: { roomTypeId: string; nights: number; free: number }[],
  rooms = defaultRooms(),
) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text.includes("pms.inventory_days") ? "SELECT inventory" : text.trim());
      return { rows: text.includes("pms.inventory_days") ? inventory : [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  const catalog = { read: vi.fn(async () => ({ rooms })) };
  return {
    reader: createPublicPricingStayPrices(pool as unknown as Pool, catalog),
    client,
    pool,
    queries,
    catalog,
  };
}

/** Every connection ran one short read transaction with timeouts and rolled it back. */
function expectShortReads({ queries, pool, client }: ReturnType<typeof setup>) {
  const begins = queries.filter((q) => q.startsWith("BEGIN"));
  expect(begins).toHaveLength(pool.connect.mock.calls.length);
  expect(queries.filter((q) => q === "ROLLBACK")).toHaveLength(begins.length);
  expect(queries.filter((q) => q === "SET LOCAL lock_timeout = '1s'")).toHaveLength(begins.length);
  expect(queries.some((q) => /^(COMMIT|INSERT|UPDATE|DELETE)/.test(q))).toBe(false);
  expect(client.release).toHaveBeenCalledTimes(begins.length);
}

beforeEach(() => {
  authority.mockReset().mockResolvedValue({ propertyId: "property", organizationId: "org" });
  totals.mockReset();
});

describe("parseStayPricesQuery", () => {
  it("reads a stay with guests and an optional promo code", () => {
    expect(
      parseStayPricesQuery({
        checkIn: "2026-11-06",
        checkOut: "2026-11-08",
        adults: "2",
        children: "1",
        promoCode: " AUTUMN ",
      }),
    ).toEqual({
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      adults: 2,
      children: 1,
      promoCode: "AUTUMN",
    });
    expect(
      parseStayPricesQuery({ checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2" }),
    ).toMatchObject({ children: 0, promoCode: null });
  });

  // VAY-2320: a group choosing its rooms one by one asks about one room's guests at a time.
  it("reads the guests of the one room being chosen", () => {
    const base = { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "3", children: "1" };
    expect(parseStayPricesQuery({ ...base, roomAdults: "1", roomChildren: "1" })).toMatchObject({
      adults: 3,
      children: 1,
      room: { adults: 1, children: 1 },
    });
    expect(parseStayPricesQuery({ ...base, roomAdults: "2" })).toMatchObject({
      room: { adults: 2, children: 0 },
    });
    expect(parseStayPricesQuery(base)).not.toHaveProperty("room");
    for (const room of [
      { roomAdults: "0" },
      { roomChildren: "1" },
      { roomAdults: "4" },
      { roomAdults: "1", roomChildren: "2" },
      { roomAdults: "1.5" },
    ])
      expect(parseStayPricesQuery({ ...base, ...room })).toBeNull();
  });

  it.each([
    { checkIn: "2026-11-08", checkOut: "2026-11-06", adults: "2" },
    { checkIn: "2026-02-30", checkOut: "2026-03-02", adults: "2" },
    { checkIn: "2026-13-01", checkOut: "2026-13-03", adults: "2" },
    { checkIn: "2026-11-00", checkOut: "2026-11-03", adults: "2" },
    { checkIn: "2026-11-06", checkOut: "2028-11-08", adults: "2" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "0" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2.5" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: ["2", "3"] },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "60", children: "60" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2", promoCode: "x".repeat(201) },
  ])("refuses an invalid stay %#", (query) => {
    expect(parseStayPricesQuery(query)).toBeNull();
  });
});

describe("rooms for a party", () => {
  it("adds rooms until the adults, the children and everyone fit, as the old booking page did", () => {
    const room = { maxGuests: 2, maxAdults: 2, maxChildren: 1 };
    expect(roomsForParty(room, 2, 0)).toBe(1);
    expect(roomsForParty(room, 3, 0)).toBe(2);
    expect(roomsForParty(room, 2, 2)).toBe(2);
    expect(roomsForParty({ maxGuests: 4, maxAdults: 2, maxChildren: 2 }, 2, 2)).toBe(1);
    expect(roomsForParty({ maxGuests: 4, maxAdults: 4, maxChildren: 1 }, 2, 2)).toBe(2);
  });

  it("needs an adult in every room, a room that takes children, and at most nine rooms", () => {
    expect(roomsForParty({ maxGuests: 2, maxAdults: 2, maxChildren: 1 }, 1, 3)).toBeNull();
    expect(roomsForParty({ maxGuests: 4, maxAdults: 4, maxChildren: 0 }, 2, 1)).toBeNull();
    expect(roomsForParty({ maxGuests: 1, maxAdults: 1, maxChildren: 0 }, 10, 0)).toBeNull();
  });

  it("fits one room's guests within every limit, with an adult", () => {
    const room = { maxGuests: 3, maxAdults: 2, maxChildren: 1 };
    expect(oneRoomFits(room, { adults: 2, children: 1 })).toBe(true);
    expect(oneRoomFits(room, { adults: 3, children: 0 })).toBe(false);
    expect(oneRoomFits(room, { adults: 1, children: 2 })).toBe(false);
    expect(oneRoomFits({ ...room, maxGuests: 2 }, { adults: 2, children: 1 })).toBe(false);
    expect(oneRoomFits(room, { adults: 0, children: 1 })).toBe(false);
  });

  // VAY-2320: a group may mix room types, so the starting room count uses the largest rooms.
  it("starts a group at the fewest rooms it could need across room types", () => {
    const big = { occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 0 } };
    const family = { occupancy: { maxGuests: 2, maxAdults: 1, maxChildren: 1 } };
    expect(fewestRooms([big, family], { adults: 4, children: 1 })).toBe(2);
    expect(fewestRooms([big, family], { adults: 10, children: 1 })).toBe(3);
    expect(fewestRooms([big], { adults: 2, children: 1 })).toBeNull();
    expect(fewestRooms([family], { adults: 2, children: 0 })).toBe(2);
    expect(fewestRooms([family], { adults: 10, children: 0 })).toBeNull();
    expect(fewestRooms([], { adults: 2, children: 0 })).toBeNull();
  });

  it("spreads adults evenly", () => {
    expect(splitAdults(5, 2)).toEqual([3, 2]);
    expect(splitAdults(4, 4)).toEqual([1, 1, 1, 1]);
  });
});

describe("createPublicPricingStayPrices", () => {
  it("prices every offer of a free room in its own short read, and reports few rooms left", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 2 },
      { roomTypeId: ROOM_B, nights: 2, free: 7 },
    ]);
    totals.mockImplementation(async (_client, _slug, selection) =>
      selection.rooms[0].publicOfferKey === "offer-a-nonref" ? null : { totalMinor: "29800" },
    );
    await expect(env.reader.read("hotel", stay)).resolves.toEqual({
      version: "public-pricing-stay-prices.v1",
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      childrenPriced: true,
      suggestedRooms: 1,
      rooms: [
        {
          roomTypeId: ROOM_A,
          roomCount: 1,
          availability: "available",
          roomsLeft: 2,
          offers: [
            {
              publicOfferKey: "offer-a-free",
              status: "priced",
              totalMinor: "29800",
              currency: "EUR",
              promoApplied: false,
            },
            { publicOfferKey: "offer-a-nonref", status: "unavailable" },
          ],
        },
        {
          roomTypeId: ROOM_B,
          roomCount: 1,
          availability: "available",
          roomsLeft: null,
          offers: [
            {
              publicOfferKey: "offer-b",
              status: "priced",
              totalMinor: "29800",
              currency: "EUR",
              promoApplied: false,
            },
          ],
        },
      ],
    });
    expect(totals.mock.calls[0]![2]).toEqual({
      version: "public-pricing-selection.v1",
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      currency: "EUR",
      rooms: [
        {
          selectionId: "room-1",
          publicOfferKey: "offer-a-free",
          guests: { adults: 2, childAgesAtCheckIn: [] },
        },
      ],
      addons: [],
      promoCode: null,
    });
    // One read for free rooms, then one per offer.
    expect(env.pool.connect).toHaveBeenCalledTimes(4);
    expectShortReads(env);
    expect(env.queries).toContain("SELECT inventory");
  });

  it("doesn't price a room that is closed, missing a night or taken on any night", async () => {
    const env = setup([{ roomTypeId: ROOM_A, nights: 1, free: 3 }]);
    totals.mockResolvedValue({ totalMinor: "1000" });
    const prices = await env.reader.read("hotel", stay);
    expect(
      prices!.rooms.map(({ availability, roomsLeft, offers }) => ({
        availability,
        roomsLeft,
        statuses: offers.map(({ status }) => status),
      })),
    ).toEqual([
      { availability: "sold_out", roomsLeft: null, statuses: ["unavailable", "unavailable"] },
      { availability: "sold_out", roomsLeft: null, statuses: ["unavailable"] },
    ]);
    expect(totals).not.toHaveBeenCalled();
    expectShortReads(env);
  });

  it("checks the rate gate and every night's open, assigned and blocked rooms", async () => {
    const env = setup([]);
    await env.reader.read("hotel", stay);
    const sql = env.client.query.mock.calls
      .map(([text]) => text as string)
      .find((text) => text.includes("pms.inventory_days"))!;
    expect(sql).toContain("status = 'open' AND rate_gate_open IS NOT FALSE");
    expect(sql).toContain("LEAST(available_count, total_count - assigned_count - blocked_count)");
  });

  it("prices two rooms for a group one room can't hold, with adults spread", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 2 },
      { roomTypeId: ROOM_B, nights: 2, free: 1 },
    ]);
    totals.mockResolvedValue({ totalMinor: "59600" });
    const prices = await env.reader.read("hotel", { ...stay, adults: 3 });
    expect(prices!.rooms[0]).toMatchObject({
      roomCount: 2,
      availability: "available",
      roomsLeft: 2,
    });
    expect(prices!.rooms[1]).toMatchObject({
      roomCount: 2,
      availability: "sold_out",
      roomsLeft: null,
    });
    expect(totals.mock.calls[0]![2].rooms.map((room: { guests: unknown }) => room.guests)).toEqual([
      { adults: 2, childAgesAtCheckIn: [] },
      { adults: 1, childAgesAtCheckIn: [] },
    ]);
  });

  // VAY-2320: room by room, a type with one free room is bookable for the room being chosen,
  // and it is priced for that room's adults.
  it("sizes and prices each room type for the one room being chosen", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 1 },
      { roomTypeId: ROOM_B, nights: 2, free: 1 },
    ]);
    totals.mockResolvedValue({ totalMinor: "29800" });
    const group = { ...stay, adults: 3, children: 1 };
    const party = await env.reader.read("hotel", group);
    // The whole group in rooms of one type: no type has two free.
    expect(party!.rooms.map(({ roomCount, availability }) => [roomCount, availability])).toEqual([
      [null, "sold_out"],
      [2, "sold_out"],
    ]);
    // Free-room counts are given only to a group choosing room by room.
    expect(party!.rooms.every((room) => !("roomsFree" in room))).toBe(true);
    expect(party!.suggestedRooms).toBe(2);
    totals.mockClear();
    const adultsRoom = await env.reader.read("hotel", {
      ...group,
      room: { adults: 2, children: 0 },
    });
    expect(
      adultsRoom!.rooms.map(({ roomCount, availability, roomsFree }) => [
        roomCount,
        availability,
        roomsFree,
      ]),
    ).toEqual([
      [1, "available", 1],
      [1, "available", 1],
    ]);
    expect(adultsRoom!.childrenPriced).toBe(true);
    expect(adultsRoom!.suggestedRooms).toBe(2);
    expect(
      totals.mock.calls.map(([, , selection]) =>
        selection.rooms.map((room: { guests: unknown }) => room.guests),
      ),
    ).toEqual([
      [{ adults: 2, childAgesAtCheckIn: [] }],
      [{ adults: 2, childAgesAtCheckIn: [] }],
      [{ adults: 2, childAgesAtCheckIn: [] }],
    ]);
    // The room with the child: only the type that takes children fits it.
    const childRoom = await env.reader.read("hotel", {
      ...group,
      room: { adults: 1, children: 1 },
    });
    expect(
      childRoom!.rooms.map(({ roomCount, availability }) => [roomCount, availability]),
    ).toEqual([
      [null, "sold_out"],
      [1, "available"],
    ]);
    expect(childRoom!.childrenPriced).toBe(false);
  });

  it("suggests no room count when no type with a free room fits the group", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 3 },
      { roomTypeId: ROOM_B, nights: 2, free: 0 },
    ]);
    const prices = await env.reader.read("hotel", { ...stay, children: 1 });
    expect(prices!.suggestedRooms).toBeNull();
  });

  it("says children aren't priced and refuses rooms that take no children", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 5 },
      { roomTypeId: ROOM_B, nights: 2, free: 5 },
    ]);
    totals.mockResolvedValue({ totalMinor: "29800" });
    const prices = await env.reader.read("hotel", { ...stay, children: 1 });
    expect(prices!.childrenPriced).toBe(false);
    expect(prices!.rooms[0]).toMatchObject({ roomCount: null, availability: "sold_out" });
    expect(prices!.rooms[1]).toMatchObject({ roomCount: 1, availability: "available" });
  });

  it("falls back to the price without a promo code that doesn't apply", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 5 },
      { roomTypeId: ROOM_B, nights: 2, free: 5 },
    ]);
    totals.mockImplementation(async (_client, _slug, selection) =>
      selection.promoCode === "AUTUMN" && selection.rooms[0].publicOfferKey !== "offer-b"
        ? { totalMinor: "25000" }
        : selection.promoCode === null
          ? { totalMinor: "29800" }
          : null,
    );
    const prices = await env.reader.read("hotel", { ...stay, promoCode: "AUTUMN" });
    expect(prices!.rooms[0]!.offers[0]).toMatchObject({
      totalMinor: "25000",
      promoApplied: true,
    });
    expect(prices!.rooms[1]!.offers[0]).toMatchObject({
      totalMinor: "29800",
      promoApplied: false,
    });
  });

  it("ignores a promo code while the hotel has Promos switched off (VAY-2200)", async () => {
    const env = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 5 },
      { roomTypeId: ROOM_B, nights: 2, free: 5 },
    ]);
    const read = env.client.query.getMockImplementation()!;
    const promosOff = { rows: [{ addOns: true, promoCodes: false }] };
    env.client.query.mockImplementation(async (text: string) =>
      text.includes("booking.booking_settings")
        ? (promosOff as unknown as Awaited<ReturnType<typeof read>>)
        : read(text),
    );
    totals.mockImplementation(async (_client, _slug, selection) => ({
      totalMinor: selection.promoCode === null ? "29800" : "25000",
    }));
    const prices = await env.reader.read("hotel", { ...stay, promoCode: "AUTUMN" });
    for (const room of prices!.rooms)
      for (const offer of room.offers)
        expect(offer).toMatchObject({ totalMinor: "29800", promoApplied: false });
    expect(totals).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ promoCode: "AUTUMN" }),
    );
    expectShortReads(env);
  });

  it("prices at most 30 offers per request", async () => {
    const many = Array.from({ length: 32 }, (_, i) => ({
      publicOfferKey: `offer-${i}`,
      currency: "EUR",
    }));
    const env = setup(
      [{ roomTypeId: ROOM_A, nights: 2, free: 5 }],
      [{ ...defaultRooms()[0]!, offers: many }],
    );
    totals.mockResolvedValue({ totalMinor: "1000" });
    const prices = await env.reader.read("hotel", stay);
    expect(totals).toHaveBeenCalledTimes(30);
    expect(prices!.rooms[0]!.offers.filter(({ status }) => status === "priced")).toHaveLength(30);
    // The rest stay bookable without a price, not "unavailable".
    expect(prices!.rooms[0]!.offers.slice(30).map(({ status }) => status)).toEqual([
      "unpriced",
      "unpriced",
    ]);
  });

  it("returns nothing for a hotel without public offers or authority, and rolls back", async () => {
    const env = setup([]);
    env.catalog.read.mockResolvedValueOnce(null as never);
    await expect(env.reader.read("hotel", stay)).resolves.toBeNull();
    expect(env.pool.connect).not.toHaveBeenCalled();
    authority.mockResolvedValueOnce(null);
    await expect(env.reader.read("hotel", stay)).resolves.toBeNull();
    expectShortReads(env);
    expect(totals).not.toHaveBeenCalled();
  });
});
