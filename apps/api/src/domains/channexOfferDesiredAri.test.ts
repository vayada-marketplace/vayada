import { describe, expect, it } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms";
import { prepareChannexAdultNightPrices } from "../integrations/channexNightlyPrices.js";
import { DEFAULT_FULL_ARI_DAYS_AHEAD } from "../jobs/pmsChannexAriHorizon.js";
import {
  buildChannexOfferAriValue,
  channexOfferAriValueSha256,
  channexOfferAriValueWithoutDate,
  computeChannexOfferDesiredAri,
  type ChannexOfferAriValue,
} from "./channexOfferDesiredAri.js";

const identity = {
  externalPropertyId: "11111111-1111-4111-8111-111111111111",
  externalRatePlanId: "22222222-2222-4222-8222-222222222222",
};
const rules = {
  minArrivalNights: 2,
  maxStayNights: 14,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};

function room(patch: Partial<{ base: unknown; dates: unknown[]; stopSellOn: string }> = {}) {
  return {
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "room",
    revision: 3,
    currency: "EUR",
    capacity: { total: 2, adults: 2, children: 0 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flex",
        termsRevision: "terms3",
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base:
              "base" in patch
                ? patch.base
                : { mode: "occupancy", amountsMinor: ["10000", "13000"] },
            months: [],
            seasons: [],
            weekdays: [],
            dates: patch.dates ?? [],
          },
        },
        restrictions: {
          kind: "own",
          rules,
          seasons: [],
          dates: patch.stopSellOn
            ? [{ date: patch.stopSellOn, rules: { ...rules, stopSell: true } }]
            : [],
        },
      },
    ],
  } as PricingConfiguration;
}

// 20:00 UTC: already the next day in Colombo (UTC+05:30), still the same day in Los Angeles.
const now = new Date("2026-10-10T20:00:00.000Z");
const input = (patch: Partial<Parameters<typeof computeChannexOfferDesiredAri>[0]> = {}) => ({
  room: room(),
  propertyId: "property",
  roomTypeId: "room",
  offerId: "flex",
  identity,
  expectedRevision: 3,
  expectedTermsRevisions: { flex: "terms3" },
  salesState: "open" as const,
  timeZone: "Asia/Colombo",
  now,
  ...patch,
});
const desired = (patch: Parameters<typeof input>[0] = {}) => {
  const result = computeChannexOfferDesiredAri(input(patch));
  if (result.kind !== "desired") throw new Error(result.reason);
  return result;
};

describe("buildChannexOfferAriValue", () => {
  const prepared = () => {
    const result = prepareChannexAdultNightPrices(room(), {
      propertyId: "property",
      roomTypeId: "room",
      offerId: "flex",
      date: "2026-10-15",
      expectedRevision: 3,
      expectedTermsRevisions: { flex: "terms3" },
    });
    if (result.kind !== "prepared") throw new Error(result.reason);
    return result;
  };

  it("builds the initial-ARI entry: every occupancy, the night's rules, sales forced closed", () => {
    expect(buildChannexOfferAriValue(prepared(), identity, { forceStopSell: true })).toEqual({
      kind: "value",
      value: {
        property_id: identity.externalPropertyId,
        rate_plan_id: identity.externalRatePlanId,
        date: "2026-10-15",
        rates: [
          { occupancy: 1, rate: "100.00" },
          { occupancy: 2, rate: "130.00" },
        ],
        min_stay_arrival: 2,
        min_stay_through: 1,
        max_stay: 14,
        closed_to_arrival: false,
        closed_to_departure: false,
        stop_sell: true,
      },
    });
  });

  it("keeps the night's own stop-sell when sales are not forced closed", () => {
    const built = buildChannexOfferAriValue(prepared(), identity, { forceStopSell: false });
    expect(built).toMatchObject({ kind: "value", value: { stop_sell: false } });
  });

  it("refuses a non-positive rate instead of building a partial entry", () => {
    const result = prepared();
    const zero = {
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        projection: { ...c.projection, night: { ...c.projection.night, totalMinor: "0" } },
      })),
    };
    expect(buildChannexOfferAriValue(zero, identity, { forceStopSell: true })).toEqual({
      kind: "unavailable",
      reason: "provider_rate_unavailable",
    });
  });
});

describe("computeChannexOfferDesiredAri", () => {
  it("starts the 500-day window at hotel-local today in the hotel's time zone", () => {
    const colombo = desired();
    expect(colombo.from).toBe("2026-10-11");
    expect(colombo.values[0]!.date).toBe("2026-10-11");
    expect(colombo.values).toHaveLength(DEFAULT_FULL_ARI_DAYS_AHEAD + 1);
    expect(colombo.through).toBe("2028-02-22");
    expect(colombo.values.at(-1)!.date).toBe("2028-02-22");
    const losAngeles = desired({ timeZone: "America/Los_Angeles" });
    expect(losAngeles.from).toBe("2026-10-10");
    expect(losAngeles.values[0]!.date).toBe("2026-10-10");
  });

  it("never produces past dates or dates beyond the horizon", () => {
    const clipped = desired({ window: { from: "2026-09-01", through: "2031-01-01" } });
    expect(clipped.from).toBe("2026-10-11");
    expect(clipped.through).toBe("2028-02-22");
    expect(clipped.values.every(({ date }) => date >= "2026-10-11" && date <= "2028-02-22")).toBe(
      true,
    );
    expect(
      desired({ window: { from: "2026-10-12", through: "2026-10-14" } }).values.map((v) => v.date),
    ).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(desired({ window: { through: "2026-10-01" } }).values).toEqual([]);
  });

  it("composes stop-sell from the night's rules and the target's sales state", () => {
    const window = { from: "2026-10-12", through: "2026-10-13" };
    const stopSells = (salesState: "open" | "closed") =>
      desired({ window, salesState, room: room({ stopSellOn: "2026-10-13" }) }).values.map(
        (v) => v.value.stop_sell,
      );
    expect(stopSells("open")).toEqual([false, true]);
    expect(stopSells("closed")).toEqual([true, true]);
  });

  it("closes an unpriced night instead of selling it", () => {
    const result = desired({
      window: { from: "2026-10-12", through: "2026-10-13" },
      room: room({
        base: null,
        dates: [
          { date: "2026-10-12", price: { mode: "occupancy", amountsMinor: ["9000", "9500"] } },
        ],
      }),
    });
    expect(result.values.map(({ date, priced }) => ({ date, priced }))).toEqual([
      { date: "2026-10-12", priced: true },
      { date: "2026-10-13", priced: false },
    ]);
    expect(result.values[1]!.value).toEqual({
      property_id: identity.externalPropertyId,
      rate_plan_id: identity.externalRatePlanId,
      date: "2026-10-13",
      stop_sell: true,
    });
  });

  it("fails the whole target on stale owner revisions, a bad time zone or window", () => {
    expect(computeChannexOfferDesiredAri(input({ expectedRevision: 4 }))).toEqual({
      kind: "unavailable",
      reason: "stale",
    });
    expect(computeChannexOfferDesiredAri(input({ timeZone: "Not/AZone" }))).toEqual({
      kind: "unavailable",
      reason: "property_timezone_unavailable",
    });
    expect(computeChannexOfferDesiredAri(input({ window: { from: "2026-02-30" } }))).toEqual({
      kind: "unavailable",
      reason: "invalid_window",
    });
  });

  it("refuses an offer the room does not have instead of closing every night", () => {
    expect(computeChannexOfferDesiredAri(input({ offerId: "missing" }))).toEqual({
      kind: "unavailable",
      reason: "selection_unavailable",
    });
  });

  it("computes a realistic 500-day horizon quickly (the configuration is parsed once)", () => {
    const busy = room() as unknown as {
      capacity: Record<string, number>;
      offers: { price: { calendar: Record<string, unknown> } }[];
    };
    busy.capacity = { total: 4, adults: 4, children: 0 };
    const prices = { mode: "occupancy", amountsMinor: ["9000", "12000", "14000", "16000"] };
    Object.assign(busy.offers[0]!.price.calendar, {
      base: prices,
      seasons: Array.from({ length: 12 }, (_, i) => ({
        name: `s${i}`,
        tier: "standard",
        from: `${String(i + 1).padStart(2, "0")}-01`,
        through: `${String(i + 1).padStart(2, "0")}-28`,
        price: prices,
      })),
      dates: Array.from({ length: 60 }, (_, i) => ({
        date: `2027-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
        price: prices,
      })),
    });
    const started = performance.now();
    const result = desired({ room: busy as unknown as PricingConfiguration });
    expect(result.values).toHaveLength(DEFAULT_FULL_ARI_DAYS_AHEAD + 1);
    expect(result.values.every((v) => v.priced)).toBe(true);
    // Re-parsing per night and occupancy took about 16 s here; parsing once takes well under 1 s.
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("hashes values independently of key order and lets equal nights share a range", () => {
    const [first, second] = desired({
      window: { from: "2026-10-12", through: "2026-10-13" },
    }).values;
    expect(first!.valueSha256).toBe(channexOfferAriValueSha256(first!.value));
    const reordered = Object.fromEntries(
      Object.entries(first!.value)
        .reverse()
        .map(([key, item]) => [
          key,
          key === "rates"
            ? (item as { occupancy: number; rate: string }[]).map(({ occupancy, rate }) => ({
                rate,
                occupancy,
              }))
            : item,
        ]),
    ) as ChannexOfferAriValue;
    expect(channexOfferAriValueSha256(reordered)).toBe(first!.valueSha256);
    expect(first!.valueSha256).not.toBe(second!.valueSha256);
    expect(channexOfferAriValueWithoutDate(first!.value)).toEqual(
      channexOfferAriValueWithoutDate(second!.value),
    );
  });
});
