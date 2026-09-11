import { describe, expect, it } from "vitest";
import type { PricingConfiguration, RoomNightProjectionRequest } from "@vayada/domain-pms";
import { prepareChannexAdultNightPrices } from "./channexNightlyPrices.js";

const request: Omit<RoomNightProjectionRequest, "guests"> = {
  propertyId: "property",
  roomTypeId: "room",
  offerId: "flex",
  expectedRevision: 7,
  expectedTermsRevisions: { flex: "terms7", nr: "terms8" },
  date: "2026-10-15",
};
function fixture(): PricingConfiguration {
  return {
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "room",
    revision: 7,
    currency: "EUR",
    capacity: { total: 4, adults: 3, children: 2 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flex",
        termsRevision: "terms7",
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights: 3,
            maxStayNights: 14,
            closedToArrival: true,
            closedToDeparture: true,
            stopSell: true,
          },
          seasons: [],
          dates: [],
        },
      },
      {
        id: "nr",
        termsRevision: "terms8",
        meal: {
          kind: "breakfast",
          charge: { kind: "person", adultMinor: "1000", childBandAmountsMinor: ["500"] },
        },
        price: {
          kind: "linked",
          parentId: "flex",
          adjustment: { kind: "percentage", basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
  };
}
function prepare(config = fixture(), input = request) {
  const result = prepareChannexAdultNightPrices(config, input);
  if (result.kind !== "prepared") throw new Error(result.reason);
  return result.candidates;
}
function withBase(base: unknown, currency = "EUR"): PricingConfiguration {
  const c = fixture();
  return {
    ...c,
    currency,
    offers: [
      {
        ...c.offers[0],
        price: {
          kind: "independent",
          calendar: {
            base,
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
      },
    ],
  } as PricingConfiguration;
}

describe("Channex adult nightly price preparation with real PMS calculator", () => {
  it("retains exact occupancy totals and restricted-night evidence", () => {
    const rows = prepare();
    expect(rows.map(({ occupancy, rate }) => ({ occupancy, rate }))).toEqual([
      { occupancy: 1, rate: "100.00" },
      { occupancy: 2, rate: "130.00" },
      { occupancy: 3, rate: "155.00" },
    ]);
    for (const row of rows) {
      expect(row.projection).toMatchObject({
        kind: "projected",
        propertyId: "property",
        roomTypeId: "room",
        offerId: "flex",
        revision: 7,
        currency: "EUR",
        termsRevisions: { flex: "terms7" },
        guests: { adults: row.occupancy, childAgesAtCheckIn: [] },
        night: {
          date: request.date,
          restrictionOfferId: "flex",
          sources: [{ offerId: "flex", kind: "base" }],
          restrictions: {
            minArrivalNights: 3,
            maxStayNights: 14,
            closedToArrival: true,
            closedToDeparture: true,
            stopSell: true,
          },
        },
      });
    }
  });
  it("uses actual occupancy for meals and retains the linked restriction owner", () => {
    const rows = prepare(fixture(), { ...request, offerId: "nr" });
    expect(rows.map((r) => r.rate)).toEqual(["100.00", "137.00", "169.50"]);
    expect(rows[2].projection).toMatchObject({
      termsRevisions: { flex: "terms7", nr: "terms8" },
      night: {
        roomMinor: "13950",
        mealMinor: "3000",
        totalMinor: "16950",
        restrictionOfferId: "flex",
        sources: [
          { offerId: "flex", kind: "base" },
          { offerId: "nr", kind: "linked" },
        ],
      },
    });
  });
  it("evaluates per-person and included-guest tariffs rather than multiplying room totals", () => {
    expect(prepare(withBase({ mode: "per_person", unitMinor: "6000" })).map((r) => r.rate)).toEqual(
      ["60.00", "120.00", "180.00"],
    );
    expect(
      prepare(
        withBase({
          mode: "included_guests",
          baseGuests: 2,
          baseMinor: "13000",
          adjustments: [
            { kind: "fixed", deltaMinor: "-3000" },
            { kind: "fixed", deltaMinor: "0" },
            { kind: "fixed", deltaMinor: "2500" },
          ],
        }),
      ).map((r) => r.rate),
    ).toEqual(["100.00", "130.00", "155.00"]);
  });
  it.each([
    ["JPY", "123", "123"],
    ["KWD", "1", "0.001"],
    ["EUR", "1", "0.01"],
    ["EUR", "999999999999999999", "9999999999999999.99"],
  ])("formats %s minor amount %s exactly", (currency, amountMinor, decimal) => {
    expect(prepare(withBase({ mode: "flat", amountMinor }, currency)).map((r) => r.rate)).toEqual([
      decimal,
      decimal,
      decimal,
    ]);
  });
  it("preserves exact-date prices and restriction clears without mutating inputs", () => {
    const c = withBase({ mode: "flat", amountMinor: "10000" });
    const first = c.offers[0];
    if (first.price.kind !== "independent" || first.restrictions.kind !== "own")
      throw new Error("fixture");
    const config = {
      ...c,
      offers: [
        {
          ...first,
          price: {
            ...first.price,
            calendar: {
              ...first.price.calendar,
              dates: [
                { date: request.date, price: { mode: "flat" as const, amountMinor: "12000" } },
              ],
            },
          },
          restrictions: {
            ...first.restrictions,
            dates: [
              {
                date: request.date,
                rules: {
                  minArrivalNights: 1,
                  maxStayNights: null,
                  closedToArrival: false,
                  closedToDeparture: false,
                  stopSell: false,
                },
              },
            ],
          },
        },
      ],
    };
    const before = structuredClone(config);
    const row = prepare(config)[0];
    expect(row.rate).toBe("120.00");
    expect(row.projection.night).toMatchObject({
      sources: [{ offerId: "flex", kind: "date" }],
      restrictions: config.offers[0].restrictions.dates[0].rules,
    });
    expect(config).toEqual(before);
  });
  it.each([
    [{ propertyId: "other" }, "invalid_request"],
    [{ roomTypeId: "other" }, "invalid_request"],
    [{ expectedRevision: 6 }, "stale"],
    [{ expectedTermsRevisions: { flex: "old" } }, "stale"],
    [{ expectedTermsRevisions: {} }, "missing_terms"],
    [{ offerId: "missing" }, "missing_price"],
    [{ date: "2026-02-30" }, "invalid_request"],
  ])("fails explicitly for invalid or stale owner evidence %j", (patch, reason) => {
    expect(prepareChannexAdultNightPrices(fixture(), { ...request, ...patch })).toEqual({
      kind: "unavailable",
      reason,
    });
  });
  it("returns no partial rows when a later occupancy overflows", () => {
    const c = withBase({ mode: "per_person", unitMinor: "500000000000000000" });
    expect(prepareChannexAdultNightPrices(c, request)).toEqual({
      kind: "unavailable",
      reason: "overflow",
    });
  });
  it("rejects invalid or missing prices without fallback", () => {
    expect(prepareChannexAdultNightPrices({}, request)).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
    expect(prepareChannexAdultNightPrices(withBase(null), request)).toEqual({
      kind: "unavailable",
      reason: "missing_price",
    });
  });
  it("bounds local candidate work without truncating an oversized room", () => {
    const c = withBase({ mode: "flat", amountMinor: "10000" });
    expect(
      prepareChannexAdultNightPrices(
        { ...c, capacity: { total: 101, adults: 101, children: 0 } },
        request,
      ),
    ).toEqual({ kind: "unavailable", reason: "candidate_limit" });
  });
});
