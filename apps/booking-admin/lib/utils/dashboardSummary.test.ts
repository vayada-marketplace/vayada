import { describe, expect, it } from "vitest";
import { compareSummary, sparklineShape } from "./dashboardSummary";

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

describe("dashboard sparkline shape", () => {
  it("stays a flat grey line until two points exist and one is nonzero", () => {
    expect(sparklineShape([])).toBeNull();
    expect(sparklineShape([5])).toBeNull();
    expect(sparklineShape([0, 0, 0])).toBeNull();
  });

  it("spans the box from the first to the last point and closes the area below", () => {
    const shape = sparklineShape([0, 2, 1]);
    expect(shape?.line).toBe("M0.00,30.00 L50.00,2.00 L100.00,16.00");
    expect(shape?.area).toBe(`${shape?.line} L100,32 L0,32 Z`);
  });

  it("draws a flat nonzero series across the middle", () => {
    expect(sparklineShape([3, 3])?.line).toBe("M0.00,16.00 L100.00,16.00");
  });
});
