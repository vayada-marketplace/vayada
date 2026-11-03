import { describe, expect, it, vi } from "vitest";
import {
  AgencyStayPricesBusy,
  cheapestRooms,
  createAgencyStayPrices,
  parseAgencyStayPricesQuery,
  splitParty,
  type StayOffers,
  type StayPrices,
} from "./agencyStayPrices.js";
import type { StayPricesQuery } from "./publicPricingStayPrices.js";

const STAY = { checkIn: "2026-11-06", checkOut: "2026-11-08", adults: "3" };
const priced = (publicOfferKey: string, totalMinor: string, promoApplied = false) => ({
  publicOfferKey,
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
/** A stay's offers: each room type with its rates, all paid in full by card unless given. */
const offered = (
  rooms: Record<
    string,
    { guests?: number; rates: (string | { key: string; deposit?: string; methods?: string[] })[] }
  >,
): StayOffers => ({
  rooms: Object.entries(rooms).map(([roomTypeId, { guests = 2, rates }]) => ({
    roomTypeId,
    occupancy: { maxGuests: guests, maxAdults: guests, maxChildren: 0 },
    offers: rates.map((rate) => {
      const { key, deposit, methods } = typeof rate === "string" ? { key: rate } : rate;
      return {
        publicOfferKey: key,
        currency: "EUR",
        paymentMethods: methods ?? ["card"],
        paymentSchedule: deposit ? { kind: "deposit", key: deposit } : { kind: "full" },
      };
    }),
  })),
});
const page = { stays: [{ propertyId: "p1", slug: "villa" }] };

describe("agency stay prices query (VAY-2458)", () => {
  it("takes the stay page's search with its number of rooms, for at most 30 nights", () => {
    expect(parseAgencyStayPricesQuery({ ...STAY, promoCode: " SAVE " })).toEqual({
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      adults: 3,
      children: 0,
      promoCode: "SAVE",
      rooms: 1,
    });
    expect(parseAgencyStayPricesQuery({ ...STAY, children: "1", rooms: "2" })).toMatchObject({
      adults: 3,
      children: 1,
      rooms: 2,
    });
    expect(
      parseAgencyStayPricesQuery({ ...STAY, checkOut: "2026-12-06" })?.checkOut, // 30 nights
    ).toBe("2026-12-06");
    for (const query of [
      { ...STAY, rooms: "4" }, // More rooms than adults.
      { ...STAY, rooms: "0" },
      { ...STAY, rooms: "2-0,1-0" },
      { ...STAY, rooms: ["2"] },
      { ...STAY, checkOut: "2026-12-07" }, // 31 nights.
      { ...STAY, roomAdults: "1" }, // The stay page's one-room read isn't an agency search.
      { ...STAY, checkOut: "2026-11-06" },
      null,
    ])
      expect(parseAgencyStayPricesQuery(query)).toBeNull();
  });

  it("spreads a group over its rooms as the stay page does", () => {
    expect(splitParty(5, 3, 2)).toEqual([
      { adults: 3, children: 1 },
      { adults: 2, children: 2 },
    ]);
    expect(splitParty(4, 0, 3)).toEqual([
      { adults: 2, children: 0 },
      { adults: 1, children: 0 },
      { adults: 1, children: 0 },
    ]);
    expect(splitParty(2, 1, 1)).toEqual([{ adults: 2, children: 1 }]);
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
  it("shows each stay's lowest bookable price for the whole party in one room, as its page opens", async () => {
    const reads: Record<string, StayPrices | null> = {
      villa: {
        rooms: [
          room("a", [priced("a1", "40000"), { publicOfferKey: "a2", status: "unavailable" }]),
          room("b", [priced("b1", "30001", true), { publicOfferKey: "b2", status: "unpriced" }]),
          // Free, but every rate refuses these dates (minimum stay): not bookable.
          room("c", [{ publicOfferKey: "c1", status: "unavailable" }]),
          room("d", [priced("d1", "100")], { availability: "sold_out" }),
        ],
      },
      full: { suggestedRooms: null, rooms: [room("a", [], { availability: "sold_out" })] },
    };
    const queries: [string, StayPricesQuery["room"]][] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => ({
        stays: ["villa", "full", "small", "gone", "broken"].map((slug) => ({
          propertyId: `id-${slug}`,
          slug,
        })),
      }),
      offers: async (slug) =>
        slug === "gone" ? null : offered({ a: { guests: slug === "small" ? 1 : 3, rates: [] } }),
      stayPrices: async (slug, query) => {
        if (slug === "broken") throw new Error("statement timeout");
        queries.push([slug, query.room]);
        // The small stay's rooms take one guest each, all taken.
        if (slug === "small")
          return {
            suggestedRooms: null,
            rooms: [
              room("a", [], {
                roomCount: query.room!.adults > 1 ? null : 1,
                availability: "sold_out",
              }),
            ],
          };
        return reads[slug]!;
      },
    });
    const warn = vi.fn();
    const search = parseAgencyStayPricesQuery(STAY)!;
    expect(await agency.read("the-travel-ubud", search, { log: { warn } })).toEqual({
      version: "agency-stay-prices.v1",
      checkIn: "2026-11-06",
      checkOut: "2026-11-08",
      childrenPriced: true,
      stays: [
        {
          propertyId: "id-villa",
          slug: "villa",
          status: "available",
          rooms: 1,
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
          rooms: 1,
          roomTypesFree: 0,
          price: null,
          pricesComplete: true,
          nextFree: null,
        },
        // No room takes three: three rooms would, and they're taken.
        {
          propertyId: "id-small",
          slug: "small",
          status: "unavailable",
          rooms: 3,
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
          rooms: 1,
          roomTypesFree: 0,
          price: null,
          pricesComplete: false,
          nextFree: null,
        },
      ],
    });
    // The page's own first read: the whole party as one room; then a room each.
    expect(queries).toContainEqual(["villa", { adults: 3, children: 0 }]);
    expect(queries).toContainEqual(["small", { adults: 1, children: 0 }]);
    // A stay that fails is logged, without the guest.
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), propertyId: "id-broken" },
      "Agency stay prices failed",
    );
  });

  it("counts no children at a stay whose page takes none, as that page does", async () => {
    const queries: StayPricesQuery[] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => ({
        stays: [{ propertyId: "p1", slug: "villa", childrenEnabled: false }],
      }),
      offers: async () => offered({ double: { rates: ["d"] } }),
      stayPrices: async (_slug, query) => {
        queries.push(query);
        return { rooms: [room("double", [priced("d", "20000")])] };
      },
    });
    const family = parseAgencyStayPricesQuery({ ...STAY, adults: "2", children: "1" })!;
    expect((await agency.read("agency", family))?.stays[0]).toEqual({
      propertyId: "p1",
      slug: "villa",
      status: "available",
      rooms: 1,
      roomTypesFree: 1,
      price: { totalMinor: "20000", nightlyMinor: "10000", currency: "EUR", promoApplied: false },
      pricesComplete: true,
      nextFree: null,
    });
    expect(queries[0]).toMatchObject({ children: 0, room: { adults: 2, children: 0 } });
  });

  it("doesn't fit when no rooms of the stay take the party", async () => {
    const agency = createAgencyStayPrices({
      pageStays: async () => page,
      // Rooms without children.
      offers: async () => offered({ double: { rates: ["d"] } }),
      stayPrices: async () => ({
        suggestedRooms: null,
        rooms: [room("double", [], { roomCount: null, availability: "sold_out" })],
      }),
    });
    const family = parseAgencyStayPricesQuery({ ...STAY, adults: "2", children: "1" })!;
    expect((await agency.read("agency", family))?.stays[0]).toMatchObject({
      status: "no_fit",
      rooms: 1,
      nextFree: null,
    });
  });

  it("offers the fewest free rooms when no one room takes the party, as the page does", async () => {
    const queries: StayPricesQuery[] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => page,
      offers: async () => offered({ double: { rates: ["d"] } }),
      stayPrices: async (_slug, query) => {
        queries.push(query);
        // Four adults: no one room; two doubles, two free.
        return query.room?.adults === 4
          ? {
              suggestedRooms: 2,
              rooms: [room("double", [], { roomCount: null, availability: "sold_out" })],
            }
          : {
              suggestedRooms: 2,
              rooms: [room("double", [priced("d", "20000")], { roomsFree: 2 })],
            };
      },
    });
    const result = await agency.read(
      "agency",
      parseAgencyStayPricesQuery({ ...STAY, adults: "4" })!,
    );
    expect(queries.map((query) => query.room)).toEqual([
      { adults: 4, children: 0 },
      { adults: 2, children: 0 },
    ]);
    expect(result?.stays[0]).toMatchObject({
      status: "available",
      rooms: 2,
      price: { totalMinor: "40000", nightlyMinor: "20000" },
    });
  });

  it("prices each room of the group on its own and takes the cheapest free set from one stay", async () => {
    const queries: StayPricesQuery[] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => page,
      offers: async () =>
        offered({ double: { rates: ["d1", "d2"] }, suite: { guests: 4, rates: ["s1"] } }),
      stayPrices: async (_slug, query) => {
        queries.push(query);
        // Three adults fit only the suite (one left); two fit both, the double cheaper.
        return query.room?.adults === 3
          ? {
              rooms: [
                room("double", [], { roomCount: null, availability: "sold_out", roomsFree: 1 }),
                room("suite", [priced("s1", "50000")], { roomsFree: 1 }),
              ],
            }
          : {
              rooms: [
                room("double", [priced("d1", "20000"), priced("d2", "25000")], { roomsFree: 1 }),
                room("suite", [priced("s1", "45000", true)], { roomsFree: 1 }),
              ],
            };
      },
    });
    // 7 adults in 3 rooms: 3 + 2 + 2. The suite for three, the double for two, and nothing left
    // for the third room.
    const three = parseAgencyStayPricesQuery({ ...STAY, adults: "7", rooms: "3" })!;
    expect((await agency.read("agency", three))?.stays[0]).toMatchObject({
      status: "unavailable",
      rooms: 3,
      price: null,
    });
    // One read per kind of room, each for that one room.
    expect(queries.map((query) => query.room)).toEqual([
      { adults: 3, children: 0 },
      { adults: 2, children: 0 },
    ]);

    const two = parseAgencyStayPricesQuery({ ...STAY, adults: "5", rooms: "2" })!;
    expect((await agency.read("agency", two))?.stays[0]).toEqual({
      propertyId: "p1",
      slug: "villa",
      status: "available",
      rooms: 2,
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

  it("combines only rates the page lets a group book together", async () => {
    const agency = (rates: StayOffers) =>
      createAgencyStayPrices({
        pageStays: async () => page,
        offers: async () => rates,
        stayPrices: async () => ({
          rooms: [
            room("double", [priced("prepaid", "10000"), priced("flex", "16000")], {
              roomsFree: 1,
            }),
            room("twin", [priced("deposit", "12000"), priced("twin-flex", "15000")], {
              roomsFree: 1,
            }),
          ],
        }),
      });
    const two = parseAgencyStayPricesQuery({ ...STAY, adults: "2", rooms: "2" })!;
    // Paid in full and a deposit can't be booked together: in full for both, 10000 + 15000.
    const schedules = await agency(
      offered({
        double: { rates: ["prepaid", "flex"] },
        twin: { rates: [{ key: "deposit", deposit: "d:30" }, "twin-flex"] },
      }),
    ).read("agency", two);
    expect(schedules?.stays[0]?.price?.totalMinor).toBe("25000");
    // Nor rates without a way to pay in common: card and bank transfer for both, 16000 + 12000.
    const methods = await agency(
      offered({
        double: {
          rates: [
            { key: "prepaid", methods: ["card"] },
            { key: "flex", methods: ["card", "bank_transfer"] },
          ],
        },
        twin: {
          rates: [
            { key: "deposit", methods: ["bank_transfer"] },
            { key: "twin-flex", methods: ["paypal"] },
          ],
        },
      }),
    ).read("agency", two);
    expect(methods?.stays[0]?.price?.totalMinor).toBe("28000");
  });

  it("prices a promo code only at the stays that have it, and keeps each stay's answer a minute", async () => {
    let at = 0;
    let shown = {
      stays: [
        { propertyId: "p1", slug: "villa" },
        { propertyId: "p2", slug: "lodge" },
      ],
    };
    const stayPrices = vi.fn(
      async (_slug: string, query: StayPricesQuery): Promise<StayPrices> => ({
        rooms: [room("a", [priced("a1", query.promoCode ? "900" : "1000", !!query.promoCode)])],
      }),
    );
    const agency = createAgencyStayPrices({
      pageStays: async () => shown,
      promoStays: async (ids, code) => new Set(code === "SAVE" ? ids.slice(0, 1) : []),
      offers: async () => offered({ a: { rates: ["a1"] } }),
      stayPrices,
      now: () => at,
    });
    const search = parseAgencyStayPricesQuery(STAY)!;
    await agency.read("p", search);
    expect(stayPrices).toHaveBeenCalledTimes(2);
    at = 59_000;
    const saved = await agency.read("p", { ...search, promoCode: "SAVE" });
    expect(saved?.stays.map((stay) => stay.price?.totalMinor)).toEqual(["900", "1000"]);
    // Only the villa has the code; the lodge's answer without it is the one kept.
    expect(stayPrices).toHaveBeenCalledTimes(3);
    expect(stayPrices.mock.calls.map(([slug, query]) => [slug, query.promoCode])).toEqual([
      ["villa", null],
      ["lodge", null],
      ["villa", "SAVE"],
    ]);
    // A code no stay has costs no price read at all.
    await agency.read("p", { ...search, promoCode: "GUESS1" });
    await agency.read("p", { ...search, promoCode: "GUESS2" });
    expect(stayPrices).toHaveBeenCalledTimes(3);
    at = 60_000;
    await agency.read("p", search);
    expect(stayPrices).toHaveBeenCalledTimes(5);
    // Hidden from the page: gone at once, kept answers or not.
    shown = { stays: [] };
    expect((await agency.read("p", search))?.stays).toEqual([]);

    // A failed read isn't kept.
    shown = page;
    stayPrices.mockRejectedValueOnce(new Error("timeout"));
    expect((await agency.read("p", { ...search, adults: 1 }))?.stays[0]?.status).toBe("unknown");
    expect((await agency.read("p", { ...search, adults: 1 }))?.stays[0]?.status).toBe("available");
  });

  it("doesn't keep a stay that isn't public now, or an answer past the search's budget", async () => {
    let publicNow = false,
      budgetLeft = 0;
    const offers = vi.fn(async () => (publicNow ? offered({ a: { rates: ["a1"] } }) : null));
    const agency = createAgencyStayPrices({
      pageStays: async () => page,
      offers,
      stayPrices: async (_slug, _query, _offered, budget) => {
        budget.left = budgetLeft;
        return { rooms: [room("a", [{ publicOfferKey: "a1", status: "unpriced" }])] };
      },
    });
    const search = parseAgencyStayPricesQuery(STAY)!;
    expect((await agency.read("agency", search))?.stays).toEqual([]);
    publicNow = true;
    // Shown again at once; its offers past the budget are unpriced, so it isn't kept.
    expect((await agency.read("agency", search))?.stays[0]).toMatchObject({
      status: "available",
      price: null,
      pricesComplete: false,
    });
    budgetLeft = 10;
    await agency.read("agency", search);
    await agency.read("agency", search);
    expect(offers).toHaveBeenCalledTimes(3);
  });

  it("prices at most 500 offers for one search, and runs four searches at once", async () => {
    const budgets: number[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const agency = createAgencyStayPrices({
      pageStays: async (slug) => {
        if (slug !== "slow") return { stays: [{ propertyId: "p1", slug: `stay-${slug}` }] };
        await waiting;
        return page;
      },
      offers: async () => offered({ a: { rates: ["a1"] } }),
      stayPrices: async (_slug, _query, _offered, budget) => {
        budgets.push(budget.left);
        return { rooms: [room("a", [priced("a1", "1000")])] };
      },
    });
    const search = parseAgencyStayPricesQuery(STAY)!;
    await agency.read("one", search);
    expect(budgets).toEqual([500]);
    const slow = Array.from({ length: 4 }, () => agency.read("slow", search));
    await expect(agency.read("fifth", search)).rejects.toBeInstanceOf(AgencyStayPricesBusy);
    release();
    await Promise.all(slow);
    expect(await agency.read("again", search)).not.toBeNull();
  });

  it("is null without a live page", async () => {
    const agency = createAgencyStayPrices({
      pageStays: async () => null,
      offers: async () => {
        throw new Error("not read");
      },
      stayPrices: async () => {
        throw new Error("not read");
      },
    });
    expect(await agency.read("nobody", parseAgencyStayPricesQuery(STAY)!)).toBeNull();
  });
});
