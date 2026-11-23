import { describe, expect, it } from "vitest";
import {
  compareConversion,
  compareSummary,
  conversionRate,
  sparklinePath,
} from "./dashboardSummary";

describe("dashboard summary comparison", () => {
  it("reports no data, no change, and signed changes with a percent only from a nonzero base", () => {
    expect(compareSummary(0, 0)).toEqual({ kind: "noData" });
    expect(compareSummary(4, 4)).toEqual({ kind: "unchanged" });
    expect(compareSummary(1240, 1050)).toMatchObject({ kind: "change", up: true, amount: 190 });
    expect((compareSummary(1240, 1050) as { percent: number }).percent).toBeCloseTo(18.1, 1);
    expect(compareSummary(3, 4)).toEqual({ kind: "change", up: false, amount: 1, percent: 25 });
    expect(compareSummary(1240, 0)).toEqual({
      kind: "change",
      up: true,
      amount: 1240,
      percent: null,
    });
  });
});

describe("dashboard conversion rate (VAY-2594)", () => {
  const steps = (visits: number, booked: number) => [
    { stage: "page_visit", count: visits },
    { stage: "rate_selected", count: Math.round(visits / 2) },
    { stage: "booking_completed", count: booked },
  ];

  it("divides confirmed bookings by visitors from one period's funnel", () => {
    expect(conversionRate(steps(200, 3))).toBeCloseTo(1.5, 5);
    expect(conversionRate(steps(0, 0))).toBeNull();
    expect(conversionRate([])).toBeNull();
  });

  it("compares two periods' rates, and nothing without a previous rate", () => {
    expect(compareConversion(1.5, 2.5)).toEqual({
      kind: "change",
      up: false,
      amount: 100,
      percent: 40,
    });
    expect(compareConversion(4.878, 3.191)).toMatchObject({ kind: "change", up: true });
    expect(compareConversion(1.501, 1.499)).toEqual({ kind: "unchanged" });
    // No bookings in either period, with visitors: unchanged, not "no data".
    expect(compareConversion(0, 0)).toEqual({ kind: "unchanged" });
    expect(compareConversion(2, 0)).toMatchObject({ kind: "change", up: true, percent: null });
    expect(compareConversion(2, null)).toBeNull();
    expect(compareConversion(null, 2)).toEqual({ kind: "noData" });
  });
});

describe("dashboard sparkline path", () => {
  it("stays a flat grey line until two points exist and one is nonzero", () => {
    expect(sparklinePath([])).toBeNull();
    expect(sparklinePath([5])).toBeNull();
    expect(sparklinePath([0, 0, 0])).toBeNull();
  });

  it("spans the box from the first to the last point", () => {
    expect(sparklinePath([0, 2, 1])).toBe("M0.00,30.00 L50.00,2.00 L100.00,16.00");
  });

  it("draws a flat nonzero series across the middle", () => {
    expect(sparklinePath([3, 3])).toBe("M0.00,16.00 L100.00,16.00");
  });
});
