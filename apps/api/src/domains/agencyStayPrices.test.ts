import { describe, expect, it, vi } from "vitest";
import {
  cheapestRooms,
  createAgencyStayPrices,
  parseAgencyStayPricesQuery,
  type StayPrices,
} from "./agencyStayPrices.js";
import type { StayPricesQuery } from "./publicPricingStayPrices.js";

const STAY = { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "3" };
const priced = (totalMinor: string, promoApplied = false) => ({
  status: "priced" as const,
  totalMinor,
  currency: "EUR",
  promoApplied,
});
const room = (
  roomTypeId: string,
  offers: StayPrices["rooms"][number]["offers"],
  more: Partial<StayPrices["rooms"][number]> = {},
): StayPrices["rooms"][number] => ({
  roomTypeId,
  roomCount: 1,
  availability: "available",
  offers,
  ...more,
});

describe("agency stay prices query (VAY-2458)", () => {
  it("takes the stay page's search and optional rooms that add up to the party", () => {
    expect(parseAgencyStayPricesQuery({ ...STAY, promoCode: " SAVE " })).toEqual({
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      adults: 3,
      children: 0,
      promoCode: "SAVE",
      rooms: null,
    });
    expect(parseAgencyStayPricesQuery({ ...STAY, children: "1", rooms: "2-1,1-0" })).toMatchObject({
      adults: 3,
      children: 1,
      rooms: [
        { adults: 2, children: 1 },
        { adults: 1, children: 0 },
      ],
    });
    for (const query of [
      { ...STAY, rooms: "2-0" }, // One adult short.
      { ...STAY, rooms: "2-0,1-1" }, // A child the party doesn't have.
      { ...STAY, rooms: "3-0,0-0" }, // A room without an adult.
      { ...STAY, rooms: "3" },
      { ...STAY, rooms: ["3-0"] },
      { ...STAY, adults: "10", rooms: Array(10).fill("1-0").join(",") },
      { ...STAY, roomAdults: "1" }, // The stay page's one-room read isn't an agency search.
      { ...STAY, checkOut: "2026-11-06" },
      null,
    ])
      expect(parseAgencyStayPricesQuery(query)).toBeNull();
  });
});

describe("cheapest rooms", () => {
  it("places every room at the lowest total within the rooms left", () => {
    // Two rooms of kind 0 and one of kind 1. Type 0 is cheapest for both, but only two are left.
    const prices = [
      [100n, 150n],
      [90n, 300n],
    ];
    const result = cheapestRooms([2, 1], [2, 5], (kind, type) => prices[kind]![type]!);
    expect(result?.total).toBe(100n + 150n + 90n);
    expect(result?.assignment.sort()).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
  });

  it("is null when the rooms can't all be placed", () => {
    expect(cheapestRooms([2], [1, 3], (_, type) => (type === 0 ? 1n : null))).toBeNull();
    expect(cheapestRooms([1, 1], [1], () => 5n)).toBeNull();
    expect(cheapestRooms([1], [1], () => 5n)).toEqual({ total: 5n, assignment: [[0, 0]] });
  });
});

describe("agency stay prices", () => {
  const page = { stays: [{ propertyId: "p1", slug: "villa" }] };

  it("shows each stay's lowest bookable price, per night, and when it can't be booked", async () => {
    const reads: Record<string, StayPrices | null> = {
      villa: {
        rooms: [
          room("a", [priced("40000"), { status: "unavailable" }]),
          room("b", [priced("30001", true), { status: "unpriced" }]),
          // Free, but every rate refuses these dates (minimum stay): not bookable.
          room("c", [{ status: "unavailable" }]),
          room("d", [priced("100")], { availability: "sold_out" }),
        ],
      },
      full: { rooms: [room("a", [], { availability: "sold_out" })] },
      small: { rooms: [room("a", [], { roomCount: null, availability: "sold_out" })] },
      gone: null,
    };
    const agency = createAgencyStayPrices({
      pageStays: async () => ({
        stays: ["villa", "full", "small", "gone", "broken"].map((slug) => ({
          propertyId: `id-${slug}`,
          slug,
        })),
      }),
      stayPrices: async (slug) => {
        if (slug === "broken") throw new Error("statement timeout");
        return reads[slug]!;
      },
    });
    const search = parseAgencyStayPricesQuery(STAY)!;
    expect(await agency.read("the-travel-ubud", search)).toEqual({
      version: "agency-stay-prices.v1",
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      childrenPriced: true,
      stays: [
        {
          propertyId: "id-villa",
          slug: "villa",
          status: "available",
          roomTypesFree: 2,
          price: {
            totalMinor: "30001",
            nightlyMinor: "15001",
            currency: "EUR",
            promoApplied: true,
          },
          pricesComplete: false,
          nextFree: null,
        },
        {
          propertyId: "id-full",
          slug: "full",
          status: "unavailable",
          roomTypesFree: 0,
          price: null,
          pricesComplete: true,
          nextFree: null,
        },
        {
          propertyId: "id-small",
          slug: "small",
          status: "no_fit",
          roomTypesFree: 0,
          price: null,
          pricesComplete: true,
          nextFree: null,
        },
        // "gone" is no longer public, so it isn't shown.
        {
          propertyId: "id-broken",
          slug: "broken",
          status: "unknown",
          roomTypesFree: 0,
          price: null,
          pricesComplete: false,
          nextFree: null,
        },
      ],
    });
  });

  it("prices each room of a split on its own and takes the cheapest free set from one stay", async () => {
    const queries: StayPricesQuery[] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => page,
      stayPrices: async (_slug, query) => {
        queries.push(query);
        // Two adults fit only the suite (one left); one adult fits both, the double cheaper.
        return query.room?.adults === 2
          ? {
              rooms: [
                room("double", [], { roomCount: null, availability: "sold_out", roomsFree: 1 }),
                room("suite", [priced("50000")], { roomsFree: 1 }),
              ],
            }
          : {
              rooms: [
                room("double", [priced("20000"), priced("25000")], { roomsFree: 1 }),
                room("suite", [priced("45000", true)], { roomsFree: 1 }),
              ],
            };
      },
    });
    const search = parseAgencyStayPricesQuery({ ...STAY, adults: "4", rooms: "2-0,1-0,1-0" })!;
    const result = await agency.read("the-travel-ubud", search);
    // One read per kind of room, each for that one room.
    expect(queries.map((query) => query.room)).toEqual([
      { adults: 2, children: 0 },
      { adults: 1, children: 0 },
    ]);
    // 2 adults: suite (the only one); then 1 double left for one of the singles, and nothing
    // for the third room: the suite is taken.
    expect(result?.stays[0]).toMatchObject({ status: "unavailable", price: null });

    const twoRooms = parseAgencyStayPricesQuery({ ...STAY, adults: "3", rooms: "2-0,1-0" })!;
    expect((await agency.read("the-travel-ubud", twoRooms))?.stays[0]).toEqual({
      propertyId: "p1",
      slug: "villa",
      status: "available",
      roomTypesFree: 2,
      price: {
        totalMinor: "70000",
        nightlyMinor: "35000",
        currency: "EUR",
        promoApplied: false,
      },
      pricesComplete: true,
      nextFree: null,
    });
  });

  it("keeps a stay's prices for a minute but reads the page's stays every time", async () => {
    let at = 0;
    let shown = page;
    const stayPrices = vi.fn(
      async (): Promise<StayPrices> => ({ rooms: [room("a", [priced("1")])] }),
    );
    const agency = createAgencyStayPrices({
      pageStays: async () => shown,
      stayPrices,
      now: () => at,
    });
    const search = parseAgencyStayPricesQuery(STAY)!;
    await agency.read("p", search);
    at = 59_000;
    await agency.read("p", search);
    expect(stayPrices).toHaveBeenCalledTimes(1);
    await agency.read("p", { ...search, promoCode: "SAVE" });
    expect(stayPrices).toHaveBeenCalledTimes(2);
    at = 60_000;
    await agency.read("p", search);
    expect(stayPrices).toHaveBeenCalledTimes(3);
    // Hidden from the page: gone at once, cached prices or not.
    shown = { stays: [] };
    expect((await agency.read("p", search))?.stays).toEqual([]);

    // A failed read isn't kept.
    shown = page;
    stayPrices.mockRejectedValueOnce(new Error("timeout"));
    expect((await agency.read("p", { ...search, adults: 1 }))?.stays[0]?.status).toBe("unknown");
    expect((await agency.read("p", { ...search, adults: 1 }))?.stays[0]?.status).toBe("available");
  });

  it("is null without a live page", async () => {
    const agency = createAgencyStayPrices({
      pageStays: async () => null,
      stayPrices: async () => {
        throw new Error("not read");
      },
    });
    expect(await agency.read("nobody", parseAgencyStayPricesQuery(STAY)!)).toBeNull();
  });
});
