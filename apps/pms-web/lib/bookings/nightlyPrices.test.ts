import { describe, expect, it } from "vitest";
import { nightlyPriceSummary, priceDigits } from "./nightlyPrices";

const nights = (...amounts: number[]) =>
  amounts.map((amount, index) => ({
    date: `2026-12-${String(1 + index).padStart(2, "0")}`,
    amount,
  }));

describe("nightlyPriceSummary (VAY-2576)", () => {
  it("averages the booked nights, which add up to the booking value", () => {
    const summary = nightlyPriceSummary(
      { amount: 1600, currency: "USD" },
      6,
      nights(250, 300, 250, 250, 250, 300),
    );
    expect(summary).toMatchObject({ currency: "USD", feesAndExtras: null, total: 1600 });
    expect(summary?.average).toBeCloseTo(266.6667, 4);
    expect(summary?.nights?.map((night) => night.amount)).toEqual([250, 300, 250, 250, 250, 300]);
  });

  it("shows what the booking value holds besides the nights as fees and extras", () => {
    const summary = nightlyPriceSummary({ amount: 1712.5, currency: "USD" }, 2, nights(800, 850));
    expect(summary).toMatchObject({ average: 825, feesAndExtras: 62.5, total: 1712.5 });
  });

  it("puts the per-night amounts' rounding on the last night, so the rows add up exactly", () => {
    const rows = (...amounts: number[]) =>
      nightlyPriceSummary({ amount: 100, currency: "EUR" }, 3, nights(...amounts));
    expect(rows(33.3333, 33.3333, 33.3334)).toMatchObject({
      nights: [{ amount: 33.33 }, { amount: 33.33 }, { amount: 33.34 }],
      feesAndExtras: null,
    });
    // A cent over the booking value is rounding too, not a reason to hide the nights.
    expect(rows(33.34, 33.33, 33.34)).toMatchObject({
      nights: [{ amount: 33.34 }, { amount: 33.33 }, { amount: 33.33 }],
      feesAndExtras: null,
    });
    expect(rows(33.33, 33.33, 33.33)?.average).toBeCloseTo(33.3333, 4);
  });

  it("shows rupiah whole, with the average rounded like the design's IDR 1.167.958", () => {
    const summary = nightlyPriceSummary(
      { amount: 7_007_746, currency: "IDR" },
      6,
      nights(1_150_000, 1_150_000, 1_150_000, 1_150_000, 1_203_873, 1_203_873),
    );
    expect(summary?.feesAndExtras).toBeNull();
    expect(Math.round(summary!.average)).toBe(1_167_958);
    expect(priceDigits("IDR", summary!.average)).toBe(0);
  });

  it("shows the booking value's average only without a price for every night", () => {
    expect(nightlyPriceSummary({ amount: 1600, currency: "USD" }, 6, null)).toEqual({
      currency: "USD",
      average: 1600 / 6,
      nights: null,
      feesAndExtras: null,
      total: 1600,
    });
    expect(nightlyPriceSummary({ amount: 1600, currency: "USD" }, 6, [])?.nights).toBeNull();
  });

  it("shows the average only when the nights come to more than the booking value", () => {
    const summary = nightlyPriceSummary({ amount: 400, currency: "USD" }, 2, nights(250, 250));
    expect(summary).toMatchObject({ average: 200, nights: null, feesAndExtras: null });
  });

  it("has nothing to show without a booking value", () => {
    expect(nightlyPriceSummary(null, 2, nights(100, 100))).toBeNull();
  });
});

describe("priceDigits", () => {
  it("shows cents only when an amount has them", () => {
    expect(priceDigits("USD", 250, 1600)).toBe(0);
    expect(priceDigits("USD", 250, 266.6667)).toBe(2);
    expect(priceDigits("EUR", 33.004)).toBe(0);
  });

  it("never shows decimals for whole-unit currencies", () => {
    expect(priceDigits("IDR", 1_167_957.67)).toBe(0);
    expect(priceDigits("JPY", 12_000.5)).toBe(0);
  });
});
