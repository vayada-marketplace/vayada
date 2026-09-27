import { describe, expect, it } from "vitest";

import { affiliatePerformancePath } from "./affiliatePerformance";

describe("affiliate performance client", () => {
  it("keeps supported filters on the target read route", () => {
    expect(
      affiliatePerformancePath({
        period: "6m",
        propertyId: "11111111-1111-4111-8111-111111111111",
        source: "unknown",
        campaign: " autumn_launch ",
        cursor: "next/page",
      }),
    ).toBe(
      "/api/marketplace/affiliate-performance?period=6m&limit=50&propertyId=11111111-1111-4111-8111-111111111111&source=unknown&campaign=autumn_launch&cursor=next%2Fpage",
    );
  });
});
