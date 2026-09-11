import { describe, expect, it } from "vitest";
import { calculateReplacementRoomStay, projectReplacementRoomNight, type RoomNightProjectionRequest, type RoomStayPricingRequest } from "./replacementPricingCalculator.js";
import { type PricingConfiguration, type PricingOffer, type PricingCalendar } from "./replacementPricingConfiguration.js";
const own = (): PricingOffer["restrictions"] => ({ kind: "own", rules: { minArrivalNights: 1, maxStayNights: null,
  closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] });
const fixture = (): PricingConfiguration => ({ version: "pricing.v2", propertyId: "property", roomTypeId: "room", revision: 1, currency: "EUR",
  capacity: { total: 4, adults: 3, children: 2 }, children: { adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 2, nightlyMinor: "0", countsTowardCapacity: false }, { fromAge: 3, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }] },
  offers: [{ id: "flex", termsRevision: "t1", meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "independent", calendar: { base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] }, months: [], seasons: [], weekdays: [], dates: [] } }, restrictions: own() },
  { id: "nr", termsRevision: "t2", meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
    price: { kind: "linked", parentId: "flex", adjustment: { kind: "percentage", basisPoints: -1000 }, dateOverrides: [] }, restrictions: { kind: "inherit" } }],
});
const request = (adults = 2, offerId = "flex"): RoomStayPricingRequest => ({ propertyId: "property", roomTypeId: "room", offerId,
  expectedRevision: 1, expectedTermsRevisions: { flex: "t1", nr: "t2" }, checkIn: "2026-07-31", checkOut: "2026-08-01", guests: { adults, childAgesAtCheckIn: [] } });
const calendar = (patch: Partial<PricingCalendar>): PricingConfiguration => {
  const c = fixture(), first = c.offers[0]; if (first.price.kind !== "independent") throw new Error("fixture");
  return { ...c, offers: [{ ...first, price: { kind: "independent", calendar: { ...first.price.calendar, ...patch } } }, c.offers[1]] };
};
const total = (config: PricingConfiguration, r = request()) => {
  const result = calculateReplacementRoomStay(config, r); expect(result.kind).toBe("priced");
  if (result.kind !== "priced") throw new Error(result.reason); return result;
};
describe("replacement room-night calculator", () => {
  it.each([[1, "10000", "9000"], [2, "13000", "11700"], [3, "15500", "13950"]] as const)("prices occupancy %i and its linked discount", (guests, flex, nr) => {
    expect(total(fixture(), request(guests)).totalMinor).toBe(flex);
    expect(total(fixture(), request(guests, "nr")).totalMinor).toBe(nr);
  });
  it("distinguishes genuine per-person rates and relative included-guest adjustments", () => {
    expect(total(calendar({ base: { mode: "per_person", unitMinor: "6000" } }), request(3)).totalMinor).toBe("18000");
    const c = calendar({ base: { mode: "included_guests", baseGuests: 2, baseMinor: "13000",
      adjustments: [{ kind: "fixed", deltaMinor: "-3000" }, { kind: "fixed", deltaMinor: "0" }, { kind: "fixed", deltaMinor: "2500" }] } });
    expect(total(c, request(1)).totalMinor).toBe("10000"); expect(total(c, request(3)).totalMinor).toBe("15500");
  });
  it("preserves included-guest deltas through season, weekday and date replacements", () => {
    const price = (baseMinor: string) => ({ mode: "included_guests" as const, baseGuests: 2, baseMinor,
      adjustments: [{ kind: "fixed" as const, deltaMinor: "-3000" }, { kind: "fixed" as const, deltaMinor: "0" }, { kind: "fixed" as const, deltaMinor: "2500" }] });
    const seasonal = { base: price("10000"), seasons: [{ name: "Summer", tier: "high", from: "07-01", through: "08-31", price: price("18000") }] };
    const weekday = { ...seasonal, weekdays: [{ day: 4, adjustment: { kind: "fixed" as const, deltaMinor: "2000" } }] };
    for (const [adults, season, weekend, date] of [[1, "15000", "17000", "9000"], [2, "18000", "20000", "12000"], [3, "20500", "22500", "14500"]] as const) {
      expect(total(calendar(seasonal), request(adults)).totalMinor).toBe(season);
      expect(total(calendar(weekday), request(adults)).totalMinor).toBe(weekend);
      expect(total(calendar({ ...weekday, dates: [{ date: "2026-07-31", price: price("12000") }] }), request(adults)).totalMinor).toBe(date);
    }
  });
  it("excludes parent meals, leaves independent NR prices unchanged and handles percentage guest rows", () => {
    const c = fixture();
    expect(total({ ...c, offers: [{ ...c.offers[0], meal: { kind: "breakfast", charge: { kind: "room", amountMinor: "5000" } } }, c.offers[1]] }, request(2, "nr")).totalMinor).toBe("11700");
    expect(total({ ...c, offers: [{ ...c.offers[0], id: "nr", termsRevision: "t2" }] }, request(2, "nr")).totalMinor).toBe("13000");
    const config = calendar({ base: { mode: "included_guests", baseGuests: 2, baseMinor: "1001", adjustments: [
      { kind: "percentage", basisPoints: -1000 }, { kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 2500 }] } });
    expect(total(config, request(1)).totalMinor).toBe("901"); expect(total(config, request(3)).totalMinor).toBe("1251");
  });
  it("matches leap-day seasons only on leap day and uses date restrictions above seasons", () => {
    const c = calendar({ base: { mode: "flat", amountMinor: "10000" }, seasons: [{ name: "Leap day", tier: "high", from: "02-29", through: "02-29", price: { mode: "flat", amountMinor: "18000" } }] });
    expect(total(c, { ...request(), checkIn: "2024-02-28", checkOut: "2024-03-02" }).totalMinor).toBe("38000");
    expect(total(c, { ...request(), checkIn: "2026-02-28", checkOut: "2026-03-01" }).totalMinor).toBe("10000");
    const policy = own(); if (policy.kind !== "own") throw new Error("fixture");
    const restrictions = { ...policy, seasons: [{ from: "07-01", through: "08-31", rules: { ...policy.rules, stopSell: true } }] };
    expect(calculateReplacementRoomStay({ ...c, offers: [{ ...c.offers[0], restrictions }] }, request())).toMatchObject({ reason: "restriction" });
    expect(total({ ...c, offers: [{ ...c.offers[0], restrictions: { ...restrictions, dates: [{ date: "2026-07-31", rules: policy.rules }] } }] }).totalMinor).toBe("10000");
  });
  it("resolves month boundaries and final overrides without duplicate weekday increases", () => {
    const base = { mode: "flat", amountMinor: "10000" } as const;
    expect(total(calendar({ base, months: [{ month: 7, price: { mode: "flat", amountMinor: "12000" } }] }),
      { ...request(), checkOut: "2026-08-02" }).totalMinor).toBe("22000");
    const weekday = [{ day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } }] as const;
    expect(total(calendar({ base, weekdays: weekday })).totalMinor).toBe("11500");
    const overridden = total(calendar({ base, weekdays: weekday, dates: [{ date: "2026-07-31", price: { mode: "flat", amountMinor: "15000" } }] }));
    expect(overridden.totalMinor).toBe("15000"); expect(overridden.nights[0].sources).toEqual([{ offerId: "flex", kind: "date" }]);
    expect(total(calendar({ base, weekdays: weekday, dates: [] })).totalMinor).toBe("11500");
  });
  it("uses seasonal precedence across New Year and fails on unpriced gaps", () => {
    const c = calendar({ base: { mode: "flat", amountMinor: "10000" }, months: [{ month: 1, price: { mode: "flat", amountMinor: "12000" } }],
      seasons: [{ name: "Winter", tier: "high", from: "12-20", through: "01-10", price: { mode: "flat", amountMinor: "18000" } }] });
    expect(total(c, { ...request(), checkIn: "2026-12-31", checkOut: "2027-01-02" }).totalMinor).toBe("36000");
    expect(calculateReplacementRoomStay(calendar({ base: null }), request())).toEqual({ kind: "unavailable", reason: "missing_price" });
  });
  it("discounts the room with child supplements before adding actual-guest meals", () => {
    const c = fixture(), nr = c.offers[1];
    const withBreakfast = { ...c, offers: [c.offers[0], { ...nr, meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["0", "500"] } } }] } as PricingConfiguration;
    expect(total(withBreakfast, request(3, "nr")).totalMinor).toBe("18450");
    const family = total(withBreakfast, { ...request(2, "nr"), checkOut: "2026-08-03", guests: { adults: 2, childAgesAtCheckIn: [8] } });
    expect(family).toMatchObject({ roomMinor: "40500", mealMinor: "10500", totalMinor: "51000" });
    const first = total(withBreakfast, request(1, "nr")), third = total(withBreakfast, request(3, "nr"));
    expect(BigInt(first.totalMinor) + BigInt(third.totalMinor)).toBe(28950n);
    const flexible = { ...withBreakfast, offers: [{ ...c.offers[0], meal: withBreakfast.offers[1].meal }, nr] };
    expect(BigInt(total(flexible, request(1)).totalMinor) + BigInt(total(flexible, request(3)).totalMinor)).toBe(31500n);
  });
  it("handles age cutoffs, free infants and all meal units without capacity shortcuts", () => {
    for (const kind of ["breakfast", "half_board", "full_board", "all_inclusive"] as const) {
      const c = fixture(), first = c.offers[0];
      expect(total({ ...c, offers: [{ ...first, meal: { kind, charge: { kind: "room", amountMinor: "3000" } } }] }, request(1)).mealMinor).toBe("3000");
    }
    expect(total(fixture(), { ...request(1), guests: { adults: 1, childAgesAtCheckIn: [12] } }).totalMinor).toBe("13000");
    expect(total(fixture(), { ...request(1), guests: { adults: 1, childAgesAtCheckIn: [1] } }).totalMinor).toBe("10000");
    expect(calculateReplacementRoomStay(fixture(), { ...request(3), guests: { adults: 3, childAgesAtCheckIn: [12] } })).toMatchObject({ reason: "invalid_guests" });
  });
  it("allows a linked final date price even without a parent price and resumes fallback after clearing", () => {
    const c = calendar({ base: null }), child = c.offers[1]; if (child.price.kind !== "linked") throw new Error("fixture");
    const overridden = { ...c, offers: [c.offers[0], { ...child, price: { ...child.price, dateOverrides: [{ date: "2026-07-31", price: { mode: "flat", amountMinor: "12000" } }] } }] } as PricingConfiguration;
    expect(total(overridden, request(2, "nr")).totalMinor).toBe("12000");
    expect(calculateReplacementRoomStay(c, request(2, "nr"))).toMatchObject({ reason: "missing_price" });
    expect(total(fixture(), request(2, "nr")).totalMinor).toBe("11700");
  });
  it("applies child supplements once through multiple links and final overrides", () => {
    const c = fixture(), child = c.offers[1]; if (child.price.kind !== "linked") throw new Error("fixture");
    const third: PricingOffer = { ...child, id: "third", termsRevision: "t3", price: { ...child.price, parentId: "nr" } };
    const r = { ...request(2, "third"), guests: { adults: 2, childAgesAtCheckIn: [8] }, expectedTermsRevisions: { flex: "t1", nr: "t2", third: "t3" } };
    expect(total({ ...c, offers: [...c.offers, third] }, r).totalMinor).toBe("12150");
    const overridden: PricingOffer = { ...child, price: { ...child.price, dateOverrides: [{ date: "2026-07-31", price: { mode: "flat", amountMinor: "12000" } }] } };
    expect(total({ ...c, offers: [c.offers[0], overridden, third] }, r).totalMinor).toBe("12600");
  });
  it("keeps currency units exact and enforces arrival closure and occupied-night stop-sell", () => {
    for (const currency of ["JPY", "KWD", "IDR"]) {
      const c = calendar({ base: { mode: "flat", amountMinor: "1001" } });
      expect(total({ ...c, currency }, request(1, "nr"))).toMatchObject({ currency, totalMinor: "901" });
    }
    const c = fixture(), policy = own(); if (policy.kind !== "own") throw new Error("fixture");
    for (const change of [{ closedToArrival: true }, { stopSell: true }]) {
      expect(calculateReplacementRoomStay({ ...c, offers: [{ ...c.offers[0], restrictions: { ...policy, rules: { ...policy.rules, ...change } } }] }, request())).toMatchObject({ reason: "restriction" });
    }
    expect(calculateReplacementRoomStay(c, { ...request(), expectedTermsRevisions: { flex: "changed" } })).toMatchObject({ reason: "stale" });
  });
  it("inherits restrictions independently from prices and permits explicit own rules", () => {
    const c = fixture(), policy = own(); if (policy.kind !== "own") throw new Error("fixture");
    const restricted = { ...c, offers: [{ ...c.offers[0], restrictions: { ...policy, rules: { ...policy.rules, minArrivalNights: 3 } } }, c.offers[1]] };
    const twoNights = { ...request(3, "nr"), checkOut: "2026-08-02" };
    expect(calculateReplacementRoomStay(restricted, twoNights)).toMatchObject({ reason: "restriction" });
    expect(total({ ...restricted, offers: [restricted.offers[0], { ...c.offers[1], restrictions: own() }] }, twoNights).totalMinor).toBe("27900");
    const dateRules = { ...policy, dates: [{ date: "2026-08-01", rules: { ...policy.rules, maxStayNights: 1 } }] };
    expect(calculateReplacementRoomStay({ ...c, offers: [{ ...c.offers[0], restrictions: dateRules }] }, { ...request(), checkOut: "2026-08-02" })).toMatchObject({ reason: "restriction" });
    const ctd = { ...policy, dates: [{ date: "2026-08-01", rules: { ...policy.rules, closedToDeparture: true } }] };
    expect(calculateReplacementRoomStay({ ...c, offers: [{ ...c.offers[0], restrictions: ctd }] }, request())).toMatchObject({ reason: "restriction" });
  });
  it("rounds each night, rejects zero and overflow, and rejects stale/missing evidence", () => {
    const tiny = calendar({ base: { mode: "flat", amountMinor: "5" } });
    expect(total(tiny, { ...request(1, "nr"), checkOut: "2026-08-02" }).totalMinor).toBe("10");
    const zero = calendar({ base: { mode: "flat", amountMinor: "1" }, weekdays: [{ day: 4, adjustment: { kind: "percentage", basisPoints: -9999 } }] });
    expect(calculateReplacementRoomStay(zero, request())).toMatchObject({ reason: "missing_price" });
    expect(calculateReplacementRoomStay(calendar({ base: { mode: "per_person", unitMinor: "999999999999999999" } }), request())).toMatchObject({ reason: "overflow" });
    expect(calculateReplacementRoomStay(fixture(), { ...request(), expectedRevision: 2 })).toMatchObject({ reason: "stale" });
    expect(calculateReplacementRoomStay(fixture(), { ...request(2, "nr"), expectedTermsRevisions: { nr: "t2" } })).toMatchObject({ reason: "missing_terms" });
    expect(calculateReplacementRoomStay(fixture(), { ...request(), checkOut: "2026-07-31" })).toMatchObject({ reason: "invalid_request" });
    expect(calculateReplacementRoomStay(fixture(), { ...request(), guests: { adults: 1, childAgesAtCheckIn: [NaN] } })).toMatchObject({ reason: "invalid_guests" });
  });
});
const nightRequest = (r = request()): RoomNightProjectionRequest => {
  const { checkIn, checkOut: _out, ...scope } = r; return { ...scope, date: checkIn };
};
const project = (c: PricingConfiguration, r = nightRequest()) => {
  const result = projectReplacementRoomNight(c, r); expect(result.kind).toBe("projected");
  if (result.kind !== "projected") throw new Error(result.reason); return result;
};
describe("nightly projection independent of Booking eligibility", () => {
  it("projects EUR120 with minimum3 while one-night Booking fails and three nights cost EUR360", () => {
    const c = calendar({ base: { mode: "flat", amountMinor: "12000" } }), policy = own(); if (policy.kind !== "own") throw new Error("fixture");
    const restricted = { ...c, offers: [{ ...c.offers[0], restrictions: { ...policy, rules: { ...policy.rules, minArrivalNights: 3 } } }] };
    const before = structuredClone(restricted);
    expect(project(restricted)).toMatchObject({ kind: "projected", propertyId: "property", roomTypeId: "room", offerId: "flex", revision: 1,
      termsRevisions: { flex: "t1" }, currency: "EUR", guests: request().guests,
      night: { date: "2026-07-31", roomMinor: "12000", mealMinor: "0", totalMinor: "12000", restrictions: { minArrivalNights: 3 }, restrictionOfferId: "flex" } });
    expect(calculateReplacementRoomStay(restricted, { ...request(), ...{ date: "2026-07-31" } })).toMatchObject({ reason: "restriction" });
    expect(total(restricted, { ...request(), checkOut: "2026-08-03" }).totalMinor).toBe("36000");
    expect(restricted).toEqual(before);
  });
  it("returns date/season/base restrictions independently of linked price ownership", () => {
    const c = fixture(), policy = own(); if (policy.kind !== "own") throw new Error("fixture");
    const rules = { ...policy.rules, minArrivalNights: 3, maxStayNights: 5, closedToArrival: true, closedToDeparture: true, stopSell: true };
    const restrictions = { ...policy, seasons: [{ from: "07-01", through: "08-31", rules }], dates: [{ date: "2026-07-31", rules: { ...rules, minArrivalNights: 4 } }] };
    const inherited = { ...c, offers: [{ ...c.offers[0], restrictions }, c.offers[1]] };
    const r = nightRequest(request(2, "nr"));
    expect(project(inherited, r).night).toMatchObject({ totalMinor: "11700", restrictions: { ...rules, minArrivalNights: 4 }, restrictionOfferId: "flex" });
    expect(project(inherited, { ...r, date: "2026-08-01" }).night.restrictions).toEqual(rules);
    expect(project(inherited, { ...r, date: "2026-09-01" }).night.restrictions).toEqual(policy.rules);
    expect(project({ ...inherited, offers: [inherited.offers[0], { ...c.offers[1], restrictions: policy }] }, r).night).toMatchObject({ restrictionOfferId: "nr", restrictions: policy.rules });
    expect(calculateReplacementRoomStay(inherited, request(2, "nr"))).toMatchObject({ reason: "restriction" });
  });
  it("shares each room mode, child/meal arithmetic, weekday and linked rounding with valid stays", () => {
    const bases: PricingCalendar["base"][] = [{ mode: "flat", amountMinor: "10001" }, { mode: "per_person", unitMinor: "6001" },
      { mode: "occupancy", amountsMinor: ["10001", "13001", "15501"] }, { mode: "included_guests", baseGuests: 2, baseMinor: "13001", adjustments: [
        { kind: "fixed", deltaMinor: "-3000" }, { kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 2500 }] }];
    for (const base of bases) {
      const c = calendar({ base, weekdays: [{ day: 4, adjustment: { kind: "percentage", basisPoints: 1500 } }] });
      const config: PricingConfiguration = { ...c, offers: [c.offers[0], { ...c.offers[1], meal: { kind: "breakfast", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["0", "500"] } } }] };
      const r = { ...request(2, "nr"), guests: { adults: 2, childAgesAtCheckIn: [8] } };
      expect(project(config, nightRequest(r)).night).toEqual(total(config, r).nights[0]);
      expect(project(config, nightRequest(r)).night.mealMinor).toBe("3500");
    }
  });
  it("uses a linked final date override despite parent price gaps and keeps restrictions", () => {
    const c = calendar({ base: null }), child = c.offers[1]; if (child.price.kind !== "linked") throw new Error("fixture");
    const config = { ...c, offers: [c.offers[0], { ...child, price: { ...child.price, dateOverrides: [{ date: "2026-07-31", price: { mode: "flat" as const, amountMinor: "12000" } }] } }] };
    const r = nightRequest({ ...request(2, "nr"), guests: { adults: 2, childAgesAtCheckIn: [8] } });
    expect(project(config, r).night).toMatchObject({ totalMinor: "14000", restrictionOfferId: "flex", sources: [{ offerId: "nr", kind: "date" }] });
    expect(projectReplacementRoomNight(config, { ...r, date: "2026-08-01" })).toMatchObject({ reason: "missing_price" });
  });
  it("rejects malformed, scoped, stale, missing-term and overflow inputs without fallback", () => {
    const r = nightRequest(request(2, "nr"));
    for (const [patch, reason] of [[{ date: "2026-02-30" }, "invalid_request"], [{ propertyId: "other" }, "invalid_request"],
      [{ roomTypeId: "other" }, "invalid_request"], [{ expectedRevision: 2 }, "stale"], [{ expectedTermsRevisions: { nr: "t2" } }, "missing_terms"],
      [{ expectedTermsRevisions: { nr: "t2", flex: "changed" } }, "stale"], [{ guests: { adults: 4, childAgesAtCheckIn: [] } }, "invalid_guests"]] as const)
      expect(projectReplacementRoomNight(fixture(), { ...r, ...patch })).toEqual({ kind: "unavailable", reason });
    expect(projectReplacementRoomNight(null, r)).toMatchObject({ reason: "invalid_configuration" });
    expect(projectReplacementRoomNight(calendar({ base: { mode: "per_person", unitMinor: "999999999999999999" } }), r)).toMatchObject({ reason: "overflow" });
    expect(project(fixture(), { ...r, date: "2024-02-29" }).night.date).toBe("2024-02-29");
  });
});
