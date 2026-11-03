import type { PricingConfiguration, PricingOffer } from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";
import { freeWindows, type FreeNight } from "./agencyNextFreeDates.js";
import {
  createAgencyStayPrices,
  splitParty,
  type StayOffers,
  type StayPrices,
} from "./agencyStayPrices.js";

type Rules = Extract<PricingOffer["restrictions"], { kind: "own" }>["rules"];
const RULES: Rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const room = (
  roomTypeId: string,
  dates: { date: string; rules: Partial<Rules> }[] = [],
  capacity = { total: 2, adults: 2, children: 0 },
): PricingConfiguration => ({
  version: "pricing.v2",
  propertyId: "property",
  roomTypeId,
  revision: 1,
  currency: "EUR",
  capacity,
  children: {
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    {
      id: "flex",
      termsRevision: "t1",
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
        rules: RULES,
        seasons: [],
        dates: dates.map(({ date, rules }) => ({ date, rules: { ...RULES, ...rules } })),
      },
    },
  ],
});
const day = (offset: number) =>
  new Date(Date.parse("2026-12-01T00:00:00Z") + offset * 86_400_000).toISOString().slice(0, 10);
/** `free` rooms of the type every night for 70 days, except the nights given. */
const nights = (roomTypeId: string, free: number, except: Record<string, number> = {}) =>
  Array.from(
    { length: 70 },
    (_, offset): FreeNight => ({
      roomTypeId,
      stayDate: day(offset),
      free: except[day(offset)] ?? free,
    }),
  );
// Searched: 2 nights from 1 December, full.
const DATES = { checkIn: day(0), checkOut: day(2) };
const first = (
  pricing: PricingConfiguration[],
  free: FreeNight[],
  slots = [{ adults: 2, children: 0 }],
) => {
  const window = freeWindows({ rooms: pricing }, free, DATES, slots, 3)[0];
  return window && { checkIn: window.checkIn, checkOut: window.checkOut };
};

describe("next free dates (VAY-2458)", () => {
  it("is the next arrival with free rooms on every night of the same length", () => {
    // Full through 4 December: the first two free nights are 5 and 6 December.
    const full = { [day(1)]: 0, [day(2)]: 0, [day(3)]: 0 };
    expect(first([room("a")], nights("a", 1, full))).toEqual({
      checkIn: day(4),
      checkOut: day(6),
    });
    // A night with nothing free in between pushes it past that night.
    expect(first([room("a")], nights("a", 1, { [day(2)]: 0 }))).toEqual({
      checkIn: day(3),
      checkOut: day(5),
    });
  });

  it("respects minimum stay, closed to arrival and departure, stop sell and maximum stay", () => {
    const free = nights("a", 1);
    // Arriving on the 2nd needs 3 nights: the 2-night stay starts on the 3rd.
    expect(first([room("a", [{ date: day(1), rules: { minArrivalNights: 3 } }])], free)).toEqual({
      checkIn: day(2),
      checkOut: day(4),
    });
    // No arrivals on the 2nd.
    expect(first([room("a", [{ date: day(1), rules: { closedToArrival: true } }])], free)).toEqual({
      checkIn: day(2),
      checkOut: day(4),
    });
    // No departures on the 4th: arriving on the 2nd can't leave then; arriving on the 3rd can.
    expect(
      first([room("a", [{ date: day(3), rules: { closedToDeparture: true } }])], free),
    ).toEqual({ checkIn: day(2), checkOut: day(4) });
    // The 3rd is a stop-sell night, so no stay can include it.
    expect(first([room("a", [{ date: day(2), rules: { stopSell: true } }])], free)).toEqual({
      checkIn: day(3),
      checkOut: day(5),
    });
    // At most one night when a stay includes the 2nd.
    expect(first([room("a", [{ date: day(1), rules: { maxStayNights: 1 } }])], free)).toEqual({
      checkIn: day(2),
      checkOut: day(4),
    });
    // Never free within 60 days.
    expect(
      freeWindows(
        { rooms: [room("a", [{ date: day(1), rules: { minArrivalNights: 3 } }])] },
        nights("a", 0),
        DATES,
        [{ adults: 2, children: 0 }],
        3,
      ),
    ).toEqual([]);
  });

  it("stops after the windows asked for, each with the rate that found it, and tries only listed rates", () => {
    const windows = freeWindows(
      { rooms: [room("a")] },
      nights("a", 1),
      DATES,
      splitParty(2, 0, 1),
      3,
    );
    expect(windows).toEqual(
      [1, 2, 3].map((offset) => ({
        checkIn: day(offset),
        checkOut: day(offset + 2),
        offers: [{ roomTypeId: "a", offerId: "flex" }],
      })),
    );
    // A rate the stay's page doesn't offer (a guest couldn't pay it) finds nothing.
    expect(
      freeWindows(
        { rooms: [room("a")] },
        nights("a", 1),
        DATES,
        splitParty(2, 0, 1),
        3,
        () => false,
      ),
    ).toEqual([]);
  });

  it("needs a free room for each of the party's rooms", () => {
    const free = [...nights("double", 1), ...nights("single", 1)];
    const rooms = [room("double"), room("single", [], { total: 1, adults: 1, children: 0 })];
    // Three adults in one room: no type takes them.
    expect(first(rooms, free, splitParty(3, 0, 1))).toBeUndefined();
    // In two rooms, a double and a single, both free.
    expect(first(rooms, free, splitParty(3, 0, 2))).toEqual({ checkIn: day(1), checkOut: day(3) });
    // Two singles but only one single and one double left: the double takes one of them.
    expect(first(rooms, free, splitParty(2, 0, 2))).toEqual({ checkIn: day(1), checkOut: day(3) });
    // Three rooms can't be placed in two free rooms.
    expect(first(rooms, free, splitParty(3, 0, 3))).toBeUndefined();
  });

  it("are confirmed with the stay's own price read of the rate that found them", async () => {
    const offers: StayOffers = {
      rooms: ["a", "b"].map((roomTypeId) => ({
        roomTypeId,
        occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        offers: [`${roomTypeId}1`, `${roomTypeId}2`].map((publicOfferKey) => ({
          publicOfferKey,
          currency: "EUR",
        })),
      })),
    };
    const read = (offered: StayOffers, available: boolean): StayPrices => ({
      rooms: offered.rooms.map((room) => ({
        roomTypeId: room.roomTypeId,
        roomCount: 1,
        availability: available ? "available" : "sold_out",
        roomsFree: available ? 2 : 0,
        offers: available
          ? room.offers.map((offer) => ({
              publicOfferKey: offer.publicOfferKey,
              status: "priced" as const,
              totalMinor: "20000",
              currency: "EUR",
              promoApplied: false,
            }))
          : [],
      })),
    });
    const confirmations: StayOffers[] = [];
    const agency = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      offers: async () => offers,
      // The rules found the 2nd and the 3rd; the stay page can't sell the 2nd.
      freeWindows: async (slug, dates, slots, offered) => {
        expect([slug, dates.checkIn, slots, offered]).toEqual([
          "villa",
          day(0),
          [{ adults: 2, children: 0 }],
          offers,
        ]);
        return [
          {
            checkIn: day(1),
            checkOut: day(3),
            offers: [{ roomTypeId: "a", publicOfferKey: "a2" }],
          },
          {
            checkIn: day(2),
            checkOut: day(4),
            offers: [{ roomTypeId: "b", publicOfferKey: "b1" }],
          },
        ];
      },
      stayPrices: async (_slug, query, offered) => {
        if (query.checkIn !== day(0)) confirmations.push(offered);
        return read(offered, query.checkIn === day(2));
      },
    });
    const search = { ...DATES, adults: 2, children: 0, promoCode: null, rooms: 1 };
    expect((await agency.read("agency", search))?.stays[0]).toMatchObject({
      status: "unavailable",
      nextFree: { checkIn: day(2), checkOut: day(4) },
    });
    // Each confirmation reads only that window's rate.
    expect(
      confirmations.map((offered) =>
        offered.rooms.flatMap((room) => room.offers.map((offer) => offer.publicOfferKey)),
      ),
    ).toEqual([["a2"], ["b1"]]);

    // A window whose rate is bookable but wasn't priced (past the search's budget) isn't shown.
    const unpriced = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      offers: async () => offers,
      freeWindows: async () => [
        { checkIn: day(1), checkOut: day(3), offers: [{ roomTypeId: "a", publicOfferKey: "a1" }] },
      ],
      stayPrices: async (_slug, query, offered) =>
        query.checkIn === day(0)
          ? read(offered, false)
          : {
              rooms: [
                {
                  roomTypeId: "a",
                  roomCount: 1,
                  availability: "available",
                  offers: [{ publicOfferKey: "a1", status: "unpriced" }],
                },
              ],
            },
    });
    expect((await unpriced.read("agency", search))?.stays[0]?.nextFree).toBeNull();

    // A group's window is confirmed with every rate of its room types, so rates the page books
    // together can be found.
    const groups: StayOffers[] = [];
    const group = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      offers: async () => offers,
      freeWindows: async () => [
        { checkIn: day(1), checkOut: day(3), offers: [{ roomTypeId: "a", publicOfferKey: "a1" }] },
      ],
      stayPrices: async (_slug, query, offered) => {
        if (query.checkIn !== day(0)) groups.push(offered);
        return read(offered, query.checkIn !== day(0));
      },
    });
    expect(
      (await group.read("agency", { ...search, adults: 4, rooms: 2 }))?.stays[0],
    ).toMatchObject({ rooms: 2, nextFree: { checkIn: day(1), checkOut: day(3) } });
    expect(
      groups[0]?.rooms.map((room) => room.offers.map((offer) => offer.publicOfferKey)),
    ).toEqual([["a1", "a2"]]);

    const warn = vi.fn();
    const failing = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      offers: async () => offers,
      freeWindows: async () => {
        throw new Error("statement timeout");
      },
      stayPrices: async (_slug, _query, offered) => read(offered, false),
    });
    expect((await failing.read("agency", search, { log: { warn } }))?.stays[0]).toMatchObject({
      status: "unavailable",
      nextFree: null,
    });
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), propertyId: "p1" },
      "Agency next free dates failed",
    );
  });
});
