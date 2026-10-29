import { describe, expect, it } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import type { CalendarRoomType } from "@/services/calendar";
import { calendarNightRates, cellPrice, nightTaken } from "./calendarPrices";

const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const flat = (amountMinor: string) => ({ mode: "flat" as const, amountMinor });
// Standard €90, "High" season €108 from 6 November, an own price of €70 on 3 November, closed on 4 November, and a
// non-refundable rate 10% below; "hidden" is published but not one of the calendar's rates.
const room = {
  version: "pricing.v2",
  propertyId: "property",
  roomTypeId: "room-type",
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
      termsRevision: "terms",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: {
          base: flat("9000"),
          months: [],
          seasons: [
            { name: "High", tier: "", from: "11-06", through: "11-08", price: flat("10800") },
          ],
          weekdays: [],
          dates: [{ date: "2026-11-03", price: flat("7000") }],
        },
      },
      restrictions: {
        kind: "own",
        rules,
        seasons: [],
        dates: [{ date: "2026-11-04", rules: { ...rules, stopSell: true } }],
      },
    },
    {
      id: "nonref",
      termsRevision: "terms-nr",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "linked",
        parentId: "flex",
        adjustment: { kind: "percentage", basisPoints: -1000 },
        dateOverrides: [],
      },
      restrictions: { kind: "inherit" },
    },
    {
      id: "hidden",
      termsRevision: "terms-h",
      meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
      price: {
        kind: "independent",
        calendar: { base: flat("100"), months: [], seasons: [], weekdays: [], dates: [] },
      },
      restrictions: { kind: "own", rules, seasons: [], dates: [] },
    },
  ],
} as unknown as PricingConfiguration;
const plan = (id: string) => ({ id, name: id, rateType: "flexible" as const, baseRate: 0 });
const roomType = (id: string, rates: string[]): CalendarRoomType => ({
  id,
  name: "Villa",
  category: "",
  totalRooms: 1,
  baseRate: 0,
  maxOccupancy: 2,
  currency: "EUR",
  ratePlans: rates.map(plan),
  seasons: [],
});

describe("calendarNightRates (VAY-2411)", () => {
  const dates = ["2026-10-31", "2026-11-03", "2026-11-04", "2026-11-06"];

  it("lists each night's open rates cheapest first, from the standard price, seasons and own date prices", () => {
    const prices = calendarNightRates(
      { rooms: [room] },
      [roomType("ROOM-TYPE", ["flex", "nonref"])],
      dates,
    );
    expect(prices["ROOM-TYPE"]).toEqual({
      "2026-10-31": [
        { offerId: "nonref", totalMinor: "8100" },
        { offerId: "flex", totalMinor: "9000" },
      ],
      "2026-11-03": [
        { offerId: "nonref", totalMinor: "6300" },
        { offerId: "flex", totalMinor: "7000" },
      ],
      // 4 November is closed to sale, so no rate is open.
      "2026-11-06": [
        { offerId: "nonref", totalMinor: "9720" },
        { offerId: "flex", totalMinor: "10800" },
      ],
    });
  });

  it("shows no prices for a room type without a publication or without the calendar's rates", () => {
    expect(
      calendarNightRates(
        { rooms: [room] },
        [roomType("room-type", ["unknown"]), roomType("other", ["flex"])],
        dates,
      ),
    ).toEqual({ "room-type": {} });
  });
});

it("fits a day cell: the full price when short, a compact figure otherwise", () => {
  expect(cellPrice("8100", "EUR", "en")).toBe("€81");
  expect(cellPrice("10850", "USD", "en")).toBe("$108.50");
  expect(cellPrice("120000", "USD", "en")).toBe("$1,200");
  expect(cellPrice("2500000", "LKR", "en")).toBe("25K");
  expect(cellPrice("125000000", "IDR", "en")).toBe("1.3M");
});

it("takes a room's night from check-in up to the check-out day", () => {
  const stays = [{ start: "2026-11-03", end: "2026-11-06" }];
  expect(
    ["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"].map((d) => nightTaken(stays, d)),
  ).toEqual([false, true, true, false]);
});
