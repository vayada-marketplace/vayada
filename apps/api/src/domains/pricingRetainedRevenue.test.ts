import { describe, expect, it } from "vitest";

import { splitByWeight } from "./pricingRetainedRevenue.js";

describe("splitByWeight (VAY-2205)", () => {
  it("splits in proportion and always adds up to the total", () => {
    expect(splitByWeight(10000n, [10000n, 10000n, 10000n])).toEqual([3334n, 3333n, 3333n]);
    expect(splitByWeight(7500n, [12000n, 8000n])).toEqual([4500n, 3000n]);
    // Uneven nights: the largest remainders get the leftover cents.
    const shares = splitByWeight(9999n, [3333n, 5000n, 1667n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(9999n);
    expect(shares).toEqual([3333n, 4999n, 1667n]);
  });

  it("gives nothing when there is nothing to split or to split over", () => {
    expect(splitByWeight(0n, [100n, 200n])).toEqual([0n, 0n]);
    expect(splitByWeight(500n, [0n, 0n])).toEqual([0n, 0n]);
  });
});
