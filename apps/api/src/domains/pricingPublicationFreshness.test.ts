import { describe, expect, it } from "vitest";

import { summarizePricingPublicationFreshness } from "./pricingPublicationFreshness.js";

describe("summarizePricingPublicationFreshness", () => {
  it("counts stale and unreadable publications as problems", () => {
    expect(
      summarizePricingPublicationFreshness([
        { propertyId: "a", revision: 3, stale: [] },
        { propertyId: "b", revision: 1, stale: ["finance"] },
        { propertyId: "c", error: "lock_timeout" },
      ]),
    ).toEqual({
      checked: 3,
      stale: 1,
      errors: 1,
      problems: 2,
      staleProperties: [{ propertyId: "b", revision: 1, stale: ["finance"] }],
      erroredProperties: [{ propertyId: "c", error: "lock_timeout" }],
    });
  });

  it("reports no problems for current or absent publications", () => {
    expect(summarizePricingPublicationFreshness([])).toMatchObject({ checked: 0, problems: 0 });
    expect(
      summarizePricingPublicationFreshness([{ propertyId: "a", revision: 2, stale: [] }]),
    ).toMatchObject({ checked: 1, problems: 0 });
  });

  it("caps the listed properties so the log line stays small", () => {
    const report = Array.from({ length: 25 }, (_, index) => ({
      propertyId: String(index),
      revision: 1,
      stale: ["room" as const],
    }));
    const summary = summarizePricingPublicationFreshness(report);
    expect(summary).toMatchObject({ stale: 25, problems: 25 });
    expect(summary.staleProperties).toHaveLength(20);
  });
});
