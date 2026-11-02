import type { PricingConfiguration, PricingOffer } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";
import { freeWindows, type FreeNight } from "./agencyNextFreeDates.js";
import { createAgencyStayPrices, parseAgencyStayPricesQuery } from "./agencyStayPrices.js";

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
const search = (more: Record<string, string> = {}) =>
  parseAgencyStayPricesQuery({
    checkIn: day(0),
    checkOut: day(2),
    adults: "2",
    ...more,
  })!;
const first = (pricing: PricingConfiguration[], free: FreeNight[], s = search()) =>
  freeWindows({ rooms: pricing }, free, s)[0];

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
        search(),
      ),
    ).toEqual([]);
  });

  it("needs enough rooms of one type for the whole party, or a room for each room of a split", () => {
    const free = [...nights("double", 1), ...nights("single", 1)];
    const rooms = [room("double"), room("single", [], { total: 1, adults: 1, children: 0 })];
    // Three adults: two doubles would be needed, and one is left; no single type fits them.
    expect(first(rooms, free, search({ adults: "3" }))).toBeUndefined();
    // Split into a double and a single, both free.
    expect(first(rooms, free, search({ adults: "3", rooms: "2-0,1-0" }))).toEqual({
      checkIn: day(1),
      checkOut: day(3),
    });
    // Two singles but only one single and one double left: the double takes one of them.
    expect(first(rooms, free, search({ adults: "2", rooms: "1-0,1-0" }))).toEqual({
      checkIn: day(1),
      checkOut: day(3),
    });
    // Three single rooms can't be placed in two free rooms.
    expect(first(rooms, free, search({ adults: "3", rooms: "1-0,1-0,1-0" }))).toBeUndefined();
  });

  it("are confirmed with the stay's own price read before a card shows them", async () => {
    const sold = {
      rooms: [{ roomTypeId: "a", roomCount: 1, availability: "sold_out" as const, offers: [] }],
    };
    const open = {
      rooms: [
        {
          roomTypeId: "a",
          roomCount: 1,
          availability: "available" as const,
          offers: [
            {
              status: "priced" as const,
              totalMinor: "20000",
              currency: "EUR",
              promoApplied: false,
            },
          ],
        },
      ],
    };
    const agency = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      // The rules found the 2nd and the 3rd; the stay page can't sell the 2nd.
      freeWindows: async () => [
        { checkIn: day(1), checkOut: day(3) },
        { checkIn: day(2), checkOut: day(4) },
      ],
      stayPrices: async (_slug, query) => (query.checkIn === day(2) ? open : sold),
    });
    expect((await agency.read("agency", search()))?.stays[0]).toMatchObject({
      status: "unavailable",
      nextFree: { checkIn: day(2), checkOut: day(4) },
    });

    const failing = createAgencyStayPrices({
      pageStays: async () => ({ stays: [{ propertyId: "p1", slug: "villa" }] }),
      freeWindows: async () => {
        throw new Error("statement timeout");
      },
      stayPrices: async () => sold,
    });
    expect((await failing.read("agency", search()))?.stays[0]).toMatchObject({
      status: "unavailable",
      nextFree: null,
    });
  });
});
