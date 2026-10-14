import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const authority = vi.hoisted(() => vi.fn());
const totals = vi.hoisted(() => vi.fn());
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: authority }));
vi.mock("./publicPricingChargeTotals.js", () => ({ lockPublicPricingChargeTotals: totals }));

import {
  createPublicPricingStayPrices,
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

function setup(inventory: { roomTypeId: string; nights: number; free: number }[]) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text.trim().split(/\s+/)[0]!);
      return { rows: text.includes("pms.inventory_days") ? inventory : [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const catalog = {
    read: vi.fn(async () => ({
      rooms: [
        {
          roomTypeId: ROOM_A,
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
          offers: [
            { publicOfferKey: "offer-a-free", currency: "EUR" },
            { publicOfferKey: "offer-a-nonref", currency: "EUR" },
          ],
        },
        {
          roomTypeId: ROOM_B,
          occupancy: { maxGuests: 4, maxAdults: 2, maxChildren: 2 },
          offers: [{ publicOfferKey: "offer-b", currency: "EUR" }],
        },
      ],
    })),
  };
  return { reader: createPublicPricingStayPrices(pool, catalog), client, queries, catalog };
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
    ).toMatchObject({
      children: 0,
      promoCode: null,
    });
  });

  it.each([
    { checkIn: "2026-11-08", checkOut: "2026-11-06", adults: "2" },
    { checkIn: "2026-02-30", checkOut: "2026-03-02", adults: "2" },
    { checkIn: "2026-11-06", checkOut: "2028-11-08", adults: "2" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "0" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2.5" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "60", children: "60" },
    { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "2", promoCode: "x".repeat(201) },
  ])("refuses an invalid stay %#", (query) => {
    expect(parseStayPricesQuery(query)).toBeNull();
  });
});

describe("rooms for a party", () => {
  it("adds rooms until the adults and everyone fit, as the old booking page did", () => {
    const room = { maxGuests: 2, maxAdults: 2, maxChildren: 0 };
    expect(roomsForParty(room, 2, 0)).toBe(1);
    expect(roomsForParty(room, 3, 0)).toBe(2);
    expect(roomsForParty(room, 2, 2)).toBe(2);
    expect(roomsForParty({ maxGuests: 4, maxAdults: 2, maxChildren: 2 }, 2, 2)).toBe(1);
  });

  it("needs an adult in every room and stops at nine rooms", () => {
    expect(roomsForParty({ maxGuests: 2, maxAdults: 2, maxChildren: 1 }, 1, 3)).toBeNull();
    expect(roomsForParty({ maxGuests: 1, maxAdults: 1, maxChildren: 0 }, 10, 0)).toBeNull();
  });

  it("spreads adults evenly", () => {
    expect(splitAdults(5, 2)).toEqual([3, 2]);
    expect(splitAdults(4, 4)).toEqual([1, 1, 1, 1]);
  });
});

describe("createPublicPricingStayPrices", () => {
  it("prices every offer for the stay and reports free rooms, then rolls back", async () => {
    const { reader, client, queries } = setup([
      { roomTypeId: ROOM_A, nights: 2, free: 2 },
      { roomTypeId: ROOM_B, nights: 2, free: 7 },
    ]);
    totals.mockImplementation(async (_client, _slug, selection) =>
      selection.rooms[0].publicOfferKey === "offer-a-nonref" ? null : { totalMinor: "29800" },
    );
    await expect(reader.read("hotel", stay)).resolves.toEqual({
      version: "public-pricing-stay-prices.v1",
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
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
    expect(queries[0]).toBe("BEGIN");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(queries.some((q) => q === "INSERT" || q === "UPDATE")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("is sold out when a night is closed, missing or taken", async () => {
    const { reader } = setup([{ roomTypeId: ROOM_A, nights: 1, free: 3 }]);
    totals.mockResolvedValue({ totalMinor: "1000" });
    const prices = await reader.read("hotel", stay);
    expect(
      prices!.rooms.map(({ availability, roomsLeft }) => ({ availability, roomsLeft })),
    ).toEqual([
      { availability: "sold_out", roomsLeft: null },
      { availability: "sold_out", roomsLeft: null },
    ]);
  });

  it("prices two rooms for a group one room can't hold", async () => {
    const { reader } = setup([{ roomTypeId: ROOM_A, nights: 2, free: 1 }]);
    totals.mockResolvedValue({ totalMinor: "59600" });
    const prices = await reader.read("hotel", { ...stay, adults: 3 });
    expect(prices!.rooms[0]).toMatchObject({ roomCount: 2, availability: "sold_out" });
    expect(totals.mock.calls[0]![2].rooms.map((room: { guests: unknown }) => room.guests)).toEqual([
      { adults: 2, childAgesAtCheckIn: [] },
      { adults: 1, childAgesAtCheckIn: [] },
    ]);
  });

  it("falls back to the price without a promo code that doesn't apply", async () => {
    const { reader } = setup([{ roomTypeId: ROOM_A, nights: 2, free: 5 }]);
    totals.mockImplementation(async (_client, _slug, selection) =>
      selection.promoCode === "AUTUMN" && selection.rooms[0].publicOfferKey !== "offer-b"
        ? { totalMinor: "25000" }
        : selection.promoCode === null
          ? { totalMinor: "29800" }
          : null,
    );
    const prices = await reader.read("hotel", { ...stay, promoCode: "AUTUMN" });
    expect(prices!.rooms[0]!.offers[0]).toMatchObject({ totalMinor: "25000", promoApplied: true });
    expect(prices!.rooms[1]!.offers[0]).toMatchObject({ totalMinor: "29800", promoApplied: false });
  });

  it("returns nothing for a hotel without public offers or authority, and rolls back", async () => {
    const { reader, catalog, queries, client } = setup([]);
    catalog.read.mockResolvedValueOnce(null as never);
    await expect(reader.read("hotel", stay)).resolves.toBeNull();
    authority.mockResolvedValueOnce(null);
    await expect(reader.read("hotel", stay)).resolves.toBeNull();
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
