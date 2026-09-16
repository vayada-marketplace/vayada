import { describe, expect, it } from "vitest";
import { parsePricingConfiguration, type PricingConfiguration } from "./replacementPricingConfiguration.js";
import { convertPricingConfigurationCurrency as convert, isCompletePricingCurrencyConversion as complete, type PricingConversionRate } from "./replacementPricingConversion.js";
const now = Date.parse("2026-09-10T12:00:00.000Z");
const fx: PricingConversionRate = { id: "owner-observation-1", from: "EUR", to: "JPY", numerator: "8", denominator: "5",
  observedAt: "2026-09-10T11:00:00.000Z", expiresAt: "2026-09-10T13:00:00.000Z" }; // EUR 1 = JPY 160: 100 EUR minor -> 160 JPY minor
const rules = { minArrivalNights: 2, maxStayNights: 20, closedToArrival: false, closedToDeparture: true, stopSell: false };
const occupancy = { mode: "occupancy" as const, amountsMinor: ["10000", "15000"] };
const fixture = (): PricingConfiguration => ({
  version: "pricing.v2", propertyId: "property-1", roomTypeId: "room-1", revision: 4, currency: "EUR", capacity: { total: 3, adults: 2, children: 1 },
  children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "500", countsTowardCapacity: true }] },
  offers: [{ id: "occupancy", termsRevision: "terms-1", meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1000", childBandAmountsMinor: ["250"] } },
    price: { kind: "independent", calendar: { base: occupancy, months: [{ month: 7, price: occupancy }],
      seasons: [{ name: "summer", tier: "high", from: "08-01", through: "08-31", price: occupancy }],
      weekdays: [{ day: 1, adjustment: { kind: "fixed", deltaMinor: "-125" } }, { day: 2, adjustment: { kind: "percentage", basisPoints: 500 } }],
      dates: [{ date: "2026-12-25", price: { mode: "flat", amountMinor: "20000" } }] } },
    restrictions: { kind: "own", rules, seasons: [{ from: "08-01", through: "08-31", rules }], dates: [{ date: "2026-12-25", rules }] } },
  { id: "included", termsRevision: "terms-2", meal: { kind: "half_board", charge: { kind: "room", amountMinor: "2500" } },
    price: { kind: "independent", calendar: { base: { mode: "included_guests", baseGuests: 2, baseMinor: "12000", adjustments: [
      { kind: "fixed", deltaMinor: "-2000" }, { kind: "fixed", deltaMinor: "0" }] }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules, seasons: [], dates: [] } },
  { id: "person", termsRevision: "terms-3", meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "independent", calendar: { base: { mode: "per_person", unitMinor: "6000" }, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules, seasons: [], dates: [] } },
  { id: "linked", termsRevision: "terms-4", meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "linked", parentId: "occupancy", adjustment: { kind: "fixed", deltaMinor: "-1000" },
      dateOverrides: [{ date: "2026-12-24", price: { mode: "flat", amountMinor: "17500" } }] }, restrictions: { kind: "inherit" } }],
});
describe("complete PMS pricing currency conversion", () => {
  it("converts every monetary path and preserves rules, identities and input history", () => {
    const source = fixture(), history = structuredClone(source), result = convert(source, fx, now)!;
    expect(parsePricingConfiguration(source)).not.toBeNull();
    expect(result).toMatchObject({ currency: "JPY", revision: 5, children: { bands: [{ nightlyMinor: "800" }] } });
    expect(result.offers[0]).toMatchObject({ meal: { charge: { adultMinor: "1600", childBandAmountsMinor: ["400"] } }, price: { calendar: {
      base: { amountsMinor: ["16000", "24000"] }, months: [{ price: { amountsMinor: ["16000", "24000"] } }],
      seasons: [{ price: { amountsMinor: ["16000", "24000"] } }], weekdays: [{ adjustment: { deltaMinor: "-200" } }, { adjustment: { basisPoints: 500 } }],
      dates: [{ price: { amountMinor: "32000" } }] } } });
    expect(result.offers[1]).toMatchObject({ meal: { charge: { amountMinor: "4000" } }, price: { calendar: { base: {
      baseGuests: 2, baseMinor: "19200", adjustments: [{ deltaMinor: "-3200" }, { deltaMinor: "0" }] } } } });
    expect(result.offers[2]).toMatchObject({ meal: { charge: { amountMinor: "0" } }, price: { calendar: { base: { unitMinor: "9600" } } } });
    expect(result.offers[3]).toMatchObject({ price: { parentId: "occupancy", adjustment: { deltaMinor: "-1600" }, dateOverrides: [{ price: { amountMinor: "28000" } }] } });
    expect(result.capacity).toEqual(source.capacity);
    expect(result.offers.map((o) => [o.id, o.termsRevision, o.restrictions])).toEqual(source.offers.map((o) => [o.id, o.termsRevision, o.restrictions]));
    expect(source).toEqual(history);
  });
  it("rounds ties away from zero and accepts explicit equal minor-unit ratios across different scales", () => {
    const source = fixture();
    const result = convert(source, { ...fx, numerator: "1", denominator: "2" }, now)!;
    expect(result.offers[0].price).toMatchObject({ calendar: { weekdays: [{ adjustment: { deltaMinor: "-63" } }, { adjustment: { basisPoints: 500 } }] } });
    const kwd = { ...source, currency: "KWD", children: { ...source.children, bands: [{ ...source.children.bands[0], nightlyMinor: "1001" }] } };
    // KWD 1 = IDR 50,000: 1,000 KWD minor -> 5,000,000 IDR minor (ISO scale 2).
    expect(convert(kwd, { ...fx, from: "KWD", to: "IDR", numerator: "5000", denominator: "1" }, now)?.children.bands[0].nightlyMinor).toBe("5005000");
    expect(convert(source, { ...fx, numerator: "1", denominator: "1" }, now)?.currency).toBe("JPY");
    const large = { ...source, children: { ...source.children, bands: [{ ...source.children.bands[0], nightlyMinor: "9007199254740993" }] } };
    expect(convert(large, { ...fx, numerator: "1", denominator: "2" }, now)?.children.bands[0].nightlyMinor).toBe("4503599627370497");
    expect(convert({ ...source, children: { ...source.children, bands: [{ ...source.children.bands[0], nightlyMinor: "1" }] } },
      { ...fx, numerator: "1", denominator: "2" }, now)?.children.bands[0].nightlyMinor).toBe("1");
  });
  it("rejects positive child and meal tariffs rounded to zero while preserving free tariffs", () => {
    const source = fixture(), rate = { ...fx, numerator: "1", denominator: "3" };
    const variants: PricingConfiguration[] = [
      { ...source, children: { ...source.children, bands: [{ ...source.children.bands[0], nightlyMinor: "1" }] } },
      ...[{ kind: "room", amountMinor: "1" },
        { kind: "person", adultMinor: "1", childBandAmountsMinor: ["250"] },
        { kind: "person", adultMinor: "1000", childBandAmountsMinor: ["1"] }].map((charge) => ({ ...source,
          offers: source.offers.map((o, i) => i === 0 ? { ...o, meal: { ...o.meal, charge } } : o) })) as PricingConfiguration[],
    ];
    for (const value of variants) {
      expect(parsePricingConfiguration(value)).not.toBeNull();
      expect(convert(value, rate, now)).toBeNull();
      expect(complete([value], [convert(source, rate, now)!], rate, now)).toBe(false);
    }
    expect(convert(source, rate, now)?.offers[2].meal.charge).toEqual({ kind: "room", amountMinor: "0" });
  });
  it("rejects missing, mismatched, malformed, expired or future FX without a fallback", () => {
    for (const bad of [null, {}, { ...fx, from: "USD" }, { ...fx, to: "EUR" }, { ...fx, to: "NOT" }, { ...fx, id: " " },
      { ...fx, numerator: "0" }, { ...fx, numerator: "1.6" }, { ...fx, denominator: "0" }, { ...fx, numerator: "1".repeat(19) },
      { ...fx, observedAt: fx.expiresAt }, { ...fx, expiresAt: new Date(now).toISOString() }, { ...fx, observedAt: "2026-02-30T00:00:00.000Z" }])
      expect(convert(fixture(), bad, now)).toBeNull();
    expect(convert(fixture(), fx, NaN)).toBeNull();
    expect(convert({}, fx, now)).toBeNull();
    expect(convert(fixture(), { ...fx, numerator: "999999999999999999", denominator: "1" }, now)).toBeNull();
    expect(convert(fixture(), { ...fx, numerator: "1", denominator: "999999999999999999" }, now)).toBeNull();
  });
  it("checks the entire property room set, exact revision and unchanged non-price policy", () => {
    const before = [fixture(), { ...fixture(), roomTypeId: "room-2" }], after = before.map((r) => convert(r, fx, now)!);
    expect(complete(before, [...after].reverse(), fx, now)).toBe(true);
    const reversedKeys = JSON.parse(JSON.stringify(after, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    expect(complete(before, reversedKeys, fx, now)).toBe(true);
    for (const candidate of [[], [after[0]], [...after, after[0]], [after[0], after[0]],
      after.map((r) => ({ ...r, revision: 4 })), after.map((r) => ({ ...r, propertyId: "foreign" })),
      before.map((r) => ({ ...r, currency: "JPY", revision: 5 })),
      after.map((r) => ({ ...r, children: before[0].children })),
      after.map((r) => ({ ...r, capacity: { ...r.capacity, total: 4 } })),
      after.map((r) => ({ ...r, offers: r.offers.map((o) => ({ ...o, termsRevision: "changed" })) })),
    ]) expect(complete(before, candidate, fx, now)).toBe(false);
    expect(complete([before[0], { ...before[1], revision: 3 }], after, fx, now)).toBe(false);
    expect(complete([before[0], before[0]], after, fx, now)).toBe(false);
    expect(complete(before, after, null, now)).toBe(false);
    expect(complete([], [], fx, now)).toBe(false);
  });
});
