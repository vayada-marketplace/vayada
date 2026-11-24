import { describe, expect, it } from "vitest";
import { channelRows, roundedShares } from "./channelMix";

describe("bookings by channel (VAY-2594)", () => {
  it("lists shares largest first, each changing relative to its share before", () => {
    const rows = channelRows([
      { key: "airbnb", bookings: 8, previous: 9 },
      { key: "direct", bookings: 18, previous: 13 },
      { key: "booking_com", bookings: 16, previous: 18 },
      { key: "agoda", bookings: 5, previous: 0 },
      { key: "expedia", bookings: 0, previous: 3 },
    ]);
    expect(rows.map((row) => row.key)).toEqual(["direct", "booking_com", "airbnb", "agoda"]);
    // 18 of 47 now (38.3%), 13 of 43 before (30.2%): up 27%.
    expect(rows[0].share).toBeCloseTo(38.3, 1);
    expect(rows[0].change).toEqual({ kind: "up", percent: 27 });
    expect(rows[1].change).toEqual({ kind: "down", percent: 19 });
    expect(rows[3].change).toEqual({ kind: "new" });
    expect(rows[0].width).toBe(100);
    expect(rows[3].width).toBeCloseTo((5 / 18) * 100, 5);
  });

  it("says unchanged when the share holds, and lists nothing without bookings", () => {
    expect(
      channelRows([
        { key: "direct", bookings: 2, previous: 4 },
        { key: "airbnb", bookings: 2, previous: 4 },
      ]).map((row) => row.change),
    ).toEqual([{ kind: "unchanged" }, { kind: "unchanged" }]);
    expect(channelRows([{ key: "direct", bookings: 0, previous: 5 }])).toEqual([]);
    expect(channelRows([])).toEqual([]);
  });

  it("rounds shares to whole numbers that add up to 100", () => {
    expect(roundedShares([38.3, 34.04, 17.02, 10.64])).toEqual([38, 34, 17, 11]);
    expect(roundedShares([33.33, 33.33, 33.34])).toEqual([33, 33, 34]);
    expect(roundedShares([100])).toEqual([100]);
  });
});
