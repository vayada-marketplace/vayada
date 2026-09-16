import { describe, expect, it } from "vitest";
import { parsePricingAdjustment, parsePricingMoney, parseRoomPrice, pricingCurrencyScale } from "./replacementPricing.js";

describe("replacement money and room-price boundary", () => {
  it("retains legacy currencies and distinguishes currency scales", () => {
    for (const currency of ["EUR", "IDR", "PHP", "JPY", "KWD"]) {
      expect(parsePricingMoney({ currency, amountMinor: "123" })).not.toBeNull();
    }
    expect(pricingCurrencyScale("EUR")).toBe(2);
    for (const currency of ["AFN", "ALL", "COP", "HUF", "IDR", "IRR", "KPW", "LAK", "LBP", "MGA", "MMK", "PKR", "SOS", "SYP", "YER"])
      expect(pricingCurrencyScale(currency), currency).toBe(2);
    expect(pricingCurrencyScale("IQD")).toBe(3);
    expect(pricingCurrencyScale("JPY")).toBe(0);
    expect(pricingCurrencyScale("KWD")).toBe(3);
  });
  it.each(["1.00", "01", "-1", "1e3", " 1", "1\n", 100, "1000000000000000000"])("rejects noncanonical money %s", (amountMinor) => {
    expect(parsePricingMoney({ currency: "EUR", amountMinor })).toBeNull();
  });
  it("rejects unknown currencies and mixed/extra money fields", () => {
    expect(parsePricingMoney({ currency: "ZZZ", amountMinor: "1" })).toBeNull();
    expect(parsePricingMoney({ currency: "eur", amountMinor: "1" })).toBeNull();
    expect(parsePricingMoney({ currency: "EUR", amountMinor: "1", scale: 0 })).toBeNull();
  });
  it("represents equal occupancy totals without treating equal amounts as duplicate guests", () => {
    expect(parseRoomPrice({ mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] }, 3)).not.toBeNull();
    expect(parseRoomPrice({ mode: "occupancy", amountsMinor: ["10000", "10000"] }, 2)).not.toBeNull();
    expect(parseRoomPrice({ mode: "per_person", unitMinor: "6000" }, 3)).toEqual({ mode: "per_person", unitMinor: "6000" });
  });
  it("rejects missing, sparse, excess and mixed-mode guest inputs", () => {
    for (const amountsMinor of [["10000"], ["10000", "13000", "15500"], Array(2), ["10000", "0"]]) {
      expect(parseRoomPrice({ mode: "occupancy", amountsMinor }, 2)).toBeNull();
    }
    expect(parseRoomPrice({ mode: "occupancy", amountsMinor: ["15500"], unitMinor: "6000" }, 1)).toBeNull();
    expect(parseRoomPrice({ mode: "flat", amountMinor: "100" }, 0)).toBeNull();
  });
  it("requires a zero base delta and permits signed non-base adjustments", () => {
    const price = { mode: "included_guests", baseGuests: 2, baseMinor: "13000",
      adjustments: ["-3000", "0", "2500"].map((deltaMinor) => ({ kind: "fixed", deltaMinor })) };
    expect(parseRoomPrice(price, 3)).not.toBeNull();
    expect(parseRoomPrice({ ...price, baseGuests: 1 }, 3)).toBeNull();
    expect(parseRoomPrice({ ...price, baseMinor: "1000" }, 3)).toBeNull();
    expect(parsePricingAdjustment({ kind: "fixed", deltaMinor: "-0" })).toBeNull();
    expect(parsePricingAdjustment({ kind: "percentage", basisPoints: -10001 })).toBeNull();
  });
  it("copies inputs so later mutations cannot alter accepted contracts", () => {
    const amountsMinor = ["10000", "13000"];
    const parsed = parseRoomPrice({ mode: "occupancy", amountsMinor }, 2);
    amountsMinor[0] = "99999";
    expect(parsed).toEqual({ mode: "occupancy", amountsMinor: ["10000", "13000"] });
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
