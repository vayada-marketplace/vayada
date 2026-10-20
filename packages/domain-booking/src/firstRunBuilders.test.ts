import { describe, expect, it } from "vitest";

import {
  firstRunOperatingCalendarProposal,
  firstRunPriceMinor,
  firstRunPricing,
  firstRunRoomFacts,
} from "./index.js";

const propertyId = "3f2c4d5e-6a7b-4c8d-9e0f-112233445566";
const roomTypeId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const otherRoomTypeId = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
// A UUID: the offer id doubles as the terms revision, which pricing-v2 requires to be a UUID.
const offerId = "5d6e7f80-9a1b-4c2d-8e3f-405162738495";
const room = { name: " Classic Double ", numberOfRooms: 8, maxGuests: 2, pricePerNight: "145" };

describe("firstRunRoomFacts (VAY-2247)", () => {
  it("builds valid room facts with one double bed; children welcome up to one less than max guests", () => {
    expect(firstRunRoomFacts(room)).toEqual({
      name: "Classic Double",
      description: "",
      category: null,
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "double", quantity: 1 }],
      bedrooms: null,
      bathrooms: null,
      bathroomType: "private",
      size: null,
    });
    expect(firstRunRoomFacts({ ...room, maxGuests: 1 })?.occupancy).toEqual({
      maxGuests: 1,
      maxAdults: 1,
      maxChildren: 0,
    });
  });

  it("refuses an empty name, no rooms, too many rooms or no guests", () => {
    expect(firstRunRoomFacts({ ...room, name: "  " })).toBeNull();
    expect(firstRunRoomFacts({ ...room, numberOfRooms: 0 })).toBeNull();
    expect(firstRunRoomFacts({ ...room, numberOfRooms: 201 })).toBeNull();
    expect(firstRunRoomFacts({ ...room, maxGuests: 0 })).toBeNull();
    expect(firstRunRoomFacts({ ...room, numberOfRooms: 2.5 })).toBeNull();
  });
});

describe("firstRunPriceMinor", () => {
  it.each([
    ["145", "EUR", "14500"],
    ["145.5", "EUR", "14550"],
    ["0.99", "CHF", "99"],
    ["1500000", "IDR", "150000000"],
    ["12000", "JPY", "12000"],
  ])("%s %s → %s", (price, currency, minor) => {
    expect(firstRunPriceMinor(price, currency)).toBe(minor);
  });

  it.each([
    ["0", "EUR"],
    ["", "EUR"],
    ["12.345", "EUR"],
    ["1.5", "JPY"],
    ["1500.5", "IDR"],
    ["abc", "EUR"],
    ["10", "XXX1"],
  ])("refuses %s %s", (price, currency) => {
    expect(firstRunPriceMinor(price, currency)).toBeNull();
  });
});

describe("firstRunPricing", () => {
  const input = {
    propertyId,
    roomTypeId,
    offerId,
    currency: "EUR",
    capacity: { total: 2, adults: 2, children: 1 },
    pricePerNight: "145",
  };

  it("builds a flat room-only price paid at the property with free cancellation until 3 days", () => {
    const result = firstRunPricing(input);
    expect(result?.configuration.offers[0]).toMatchObject({
      id: offerId,
      meal: { kind: "room_only" },
      price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "14500" } } },
      restrictions: {
        kind: "own",
        rules: { minArrivalNights: 1, maxStayNights: null, stopSell: false },
      },
    });
    expect(result?.configuration.children).toEqual({
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
    });
    expect(result?.terms).toEqual({
      roomTypeId,
      offerId,
      expectedRevision: null,
      cancellation: {
        kind: "flexible",
        terms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 3,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
      },
      payment: { kind: "full", acceptedMethods: ["pay_at_property"] },
    });
  });

  it("returns null for a price or offer id the server would refuse", () => {
    expect(firstRunPricing({ ...input, offerId: "first-run-offer-1" })).toBeNull();
    expect(firstRunPricing({ ...input, pricePerNight: "0" })).toBeNull();
    expect(firstRunPricing({ ...input, currency: "IDR", pricePerNight: "1500.5" })).toBeNull();
  });
});

describe("firstRunOperatingCalendarProposal", () => {
  it("opens every active room type all year with a one-night minimum", () => {
    const proposal = firstRunOperatingCalendarProposal({
      expectedCalendarRevision: 0,
      expectedPropertyProfileRevision: 3,
      roomTypes: [
        {
          roomTypeId,
          expectedRoomFactsRevision: 1,
          expectedRoomUnitsRevision: 9,
          activeUnitCount: 8,
        },
        {
          roomTypeId: otherRoomTypeId,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 5,
          activeUnitCount: 4,
        },
      ],
    });
    expect(proposal).toMatchObject({
      expectedCalendarRevision: 0,
      expectedPropertyProfileRevision: 3,
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
    });
    expect(
      proposal?.roomTypeLimits.map((limit) => limit.startingSellableLimitCount).sort(),
    ).toEqual([4, 8]);
  });

  it("returns null without any room type", () => {
    expect(
      firstRunOperatingCalendarProposal({
        expectedCalendarRevision: 0,
        expectedPropertyProfileRevision: 1,
        roomTypes: [],
      }),
    ).toBeNull();
  });
});
