import { describe, expect, it } from "vitest";
import {
  axisLabelIndexes,
  barHeight,
  chartCeiling,
  neighbourBookingDays,
  tooltipAlign,
} from "./revenueChart";

describe("revenue chart (VAY-2594)", () => {
  it("rounds the top line up to a number whose half is round", () => {
    expect(chartCeiling(7_000_000)).toBe(8_000_000);
    expect(chartCeiling(8_000_000)).toBe(8_000_000);
    expect(chartCeiling(1_240)).toBe(2_000);
    expect(chartCeiling(310)).toBe(400);
    expect(chartCeiling(95)).toBe(100);
    expect(chartCeiling(0)).toBe(0);
  });

  it("gives days with bookings at least 3px and days without a 2px line", () => {
    expect(barHeight(4_000_000, 2, 8_000_000, 170)).toBe(85);
    expect(barHeight(10, 1, 8_000_000, 170)).toBe(3);
    // A booking in another currency has no revenue here, but the day still opens.
    expect(barHeight(0, 1, 8_000_000, 170)).toBe(3);
    expect(barHeight(0, 0, 8_000_000, 170)).toBe(2);
  });

  it("labels the first and last day and three between", () => {
    expect(axisLabelIndexes(30)).toEqual([0, 7, 15, 22, 29]);
    expect(axisLabelIndexes(90)).toEqual([0, 22, 45, 67, 89]);
    expect(axisLabelIndexes(7)).toEqual([0, 2, 3, 5, 6]);
    expect(axisLabelIndexes(1)).toEqual([0]);
  });

  it("lines up tooltips near the edges with their side", () => {
    expect(tooltipAlign(0, 30)).toBe("left");
    expect(tooltipAlign(15, 30)).toBe("center");
    expect(tooltipAlign(29, 30)).toBe("right");
  });

  it("finds the closest days with bookings on either side", () => {
    const days = [
      { date: "2026-11-01", bookings: 1 },
      { date: "2026-11-02", bookings: 0 },
      { date: "2026-11-03", bookings: 2 },
      { date: "2026-11-04", bookings: 0 },
      { date: "2026-11-05", bookings: 1 },
    ];
    expect(neighbourBookingDays(days, "2026-11-03")).toEqual({
      previous: "2026-11-01",
      next: "2026-11-05",
    });
    expect(neighbourBookingDays(days, "2026-11-01")).toEqual({
      previous: null,
      next: "2026-11-03",
    });
    expect(neighbourBookingDays(days, "2026-11-05")).toEqual({
      previous: "2026-11-03",
      next: null,
    });
  });
});
