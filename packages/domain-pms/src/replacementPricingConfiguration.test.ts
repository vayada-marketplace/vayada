import { describe, expect, it } from "vitest";
import { parsePricingConfiguration, pricingDate, validPricingGuests } from "./replacementPricingConfiguration.js";
const price = { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] };
const rules = { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false };
export const configurationFixture = () => ({
  version: "pricing.v2", propertyId: "property-1", roomTypeId: "room-1", revision: 1, currency: "EUR",
  capacity: { total: 4, adults: 3, children: 2 },
  children: { adultFromAge: 12, bands: [
    { fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false },
    { fromAge: 3, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: "terms-1", meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "independent", calendar: { base: price, months: [], seasons: [], weekdays: [], dates: [] } },
    restrictions: { kind: "own", rules, seasons: [], dates: [] } },
  { id: "nr", termsRevision: "terms-2", meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["0", "500"] } },
    price: { kind: "linked", parentId: "flex", adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] },
    restrictions: { kind: "inherit" } }],
});
describe("replacement configuration", () => {
  it("accepts full guest/meal/linked configuration with independent restriction inheritance", () => {
    expect(parsePricingConfiguration(configurationFixture())).not.toBeNull();
    for (const kind of ["breakfast", "half_board", "full_board", "all_inclusive"]) {
      const input = configurationFixture(); input.offers[1].meal.kind = kind;
      expect(parsePricingConfiguration(input)).not.toBeNull();
    }
  });
  it("rejects cycles, dangling/cross-snapshot links, duplicate offers and missing child meal prices", () => {
    for (const parentId of ["nr", "other-property-plan"]) {
      const input = configurationFixture(); input.offers[1].price.parentId = parentId;
      expect(parsePricingConfiguration(input)).toBeNull();
    }
    const input = configurationFixture(); input.offers.push(input.offers[0]);
    expect(parsePricingConfiguration(input)).toBeNull();
    const missing = configurationFixture(); missing.offers[1].meal.charge.childBandAmountsMinor = ["0"];
    expect(parsePricingConfiguration(missing)).toBeNull();
  });
  it("rejects ambiguous recurring seasons, invalid dates and gapped child bands", () => {
    const input = configurationFixture();
    const calendar = { base: price, months: [{ month: 7, price }], weekdays: [], dates: [{ date: "2026-07-31", price }],
      seasons: [{ name: "Winter", tier: "High", from: "12-20", through: "01-10", price }] };
    const withCalendar = (c: unknown) => ({ ...input, offers: [{ ...input.offers[0], price: { kind: "independent", calendar: c } }] });
    expect(parsePricingConfiguration(withCalendar(calendar))).not.toBeNull();
    expect(parsePricingConfiguration(withCalendar({ ...calendar, seasons: [...calendar.seasons, ...calendar.seasons] }))).toBeNull();
    expect(parsePricingConfiguration(withCalendar({ ...calendar, dates: [{ date: "2026-02-30", price }] }))).toBeNull();
    input.children.bands[1].fromAge = 4;
    expect(parsePricingConfiguration(input)).toBeNull();
    expect(pricingDate("2024-02-29")).toBe(true);
    expect(pricingDate("2026-02-29")).toBe(false);
  });
  it("counts adult-equivalent children and physical capacity separately", () => {
    const parsed = parsePricingConfiguration(configurationFixture())!;
    const valid = (adults: number, childAgesAtCheckIn: number[]) => validPricingGuests({ adults, childAgesAtCheckIn }, parsed.capacity, parsed.children);
    expect(valid(2, [1, 8])).toBe(true);
    expect(valid(3, [12])).toBe(false);
    expect(valid(3, [8, 9])).toBe(false);
    expect(valid(0, [12])).toBe(false);
    expect(valid(1, [-1])).toBe(false);
  });
  it("copies snapshots and refuses unsupported versions or extra fields", () => {
    const input = configurationFixture(); const parsed = parsePricingConfiguration(input)!;
    input.children.bands[0].nightlyMinor = "9000";
    expect(parsed.children.bands[0].nightlyMinor).toBe("0");
    expect(parsePricingConfiguration({ ...input, version: "pricing.v1" })).toBeNull();
    expect(parsePricingConfiguration({ ...input, providerId: "secret" })).toBeNull();
  });
});
